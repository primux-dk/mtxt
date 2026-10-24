//! The upload queue: one JSON state file per recording next to its audio,
//! loaded at start, written after every change, so the queue survives restarts.
//!
//! `Queue` holds the entries in memory. A change whose state file cannot be
//! written stays in memory as unsaved: it is shown with the error, it is
//! never uploaded, deleted or acted on, and it is written again on Retry and
//! on every tick until it lands on the disk.

pub mod backoff;
pub mod chunks;
pub mod recovery;
pub mod select;
pub mod state;
pub mod store;
pub mod uploader;

pub use state::{Event, PendingReason, RecordingState, Status};

use chrono::{DateTime, Utc};
use std::collections::HashMap;

/// Where state files go: the store, or a test double that fails on purpose.
pub trait Persist: Send + Sync {
    fn save(&self, rec: &RecordingState) -> std::io::Result<()>;
}

/// The file side of a deletion: the store, or a test double that fails on purpose.
pub trait Files {
    fn remove_state(&self, id: &str) -> std::io::Result<()>;
    fn delete_audio(&self, id: &str) -> std::io::Result<()>;
}

impl Files for store::Store {
    fn remove_state(&self, id: &str) -> std::io::Result<()> {
        store::Store::remove_state(self, id)
    }
    fn delete_audio(&self, id: &str) -> std::io::Result<()> {
        store::Store::delete_audio(self, id)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum DiscardError {
    /// Still recording or uploading.
    Busy,
    /// Its latest state is not on the disk yet.
    Unsaved,
    /// Nothing to delete here, or not a recording the library lacks.
    NotDiscardable,
    /// The state write failed: both files are as they were.
    NotSaved(String),
    /// A file could not be removed after Discarding was written.
    Files(String),
}

impl Persist for store::Store {
    fn save(&self, rec: &RecordingState) -> std::io::Result<()> {
        store::Store::save(self, rec)
    }
}

/// What a failed write does to the change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnFail {
    /// Keep the change in memory as unsaved and write it again later.
    Keep,
    /// Undo the change: the user can repeat the action.
    Revert,
}

#[derive(Debug, Default)]
pub struct Queue {
    /// Newest first.
    pub items: Vec<RecordingState>,
    /// Entries whose latest state is not on the disk yet, with the error.
    unsaved: HashMap<String, String>,
}

impl Queue {
    pub fn new(items: Vec<RecordingState>) -> Queue {
        Queue { items, unsaved: HashMap::new() }
    }

    pub fn get(&self, id: &str) -> Option<&RecordingState> {
        self.items.iter().find(|r| r.id == id)
    }

    pub fn unsaved_error(&self, id: &str) -> Option<&str> {
        self.unsaved.get(id).map(String::as_str)
    }

    pub fn is_saved(&self, id: &str) -> bool {
        !self.unsaved.contains_key(id)
    }

    pub fn first_unsaved_error(&self) -> Option<String> {
        self.unsaved.values().next().cloned()
    }

    /// Apply an event and write the entry.
    pub fn apply(
        &mut self,
        p: &dyn Persist,
        id: &str,
        event: Event,
        now: DateTime<Utc>,
        on_fail: OnFail,
    ) -> Result<RecordingState, String> {
        let rec = self.items.iter_mut().find(|r| r.id == id).ok_or("no such recording")?;
        let before = rec.clone();
        rec.apply(event, now);
        let after = rec.clone();
        self.write(p, before, after, on_fail)
    }

    /// Replace an entry with the uploader's copy, keeping the user's snooze.
    /// A user's ending (saved elsewhere, deleted) is not overwritten.
    pub fn put(&mut self, p: &dyn Persist, new: &RecordingState) -> Result<(), String> {
        let Some(slot) = self.items.iter_mut().find(|r| r.id == new.id) else { return Ok(()) };
        if matches!(slot.status, Status::SavedElsewhere | Status::Deleted) && slot.status != new.status {
            return Ok(());
        }
        let before = slot.clone();
        let mut after = new.clone();
        after.ask_snoozed_until = before.ask_snoozed_until.max(new.ask_snoozed_until);
        after.days_at_snooze = before.days_at_snooze.max(new.days_at_snooze);
        *slot = after.clone();
        self.write(p, before, after, OnFail::Keep).map(|_| ())
    }

    /// Replace an entry by the caller's own change (a claim).
    pub fn replace(&mut self, p: &dyn Persist, new: RecordingState, on_fail: OnFail) -> Result<RecordingState, String> {
        let slot = self.items.iter_mut().find(|r| r.id == new.id).ok_or("no such recording")?;
        let before = std::mem::replace(slot, new.clone());
        self.write(p, before, new, on_fail)
    }

    fn write(&mut self, p: &dyn Persist, before: RecordingState, after: RecordingState, on_fail: OnFail) -> Result<RecordingState, String> {
        match p.save(&after) {
            Ok(()) => {
                self.unsaved.remove(&after.id);
                Ok(after)
            }
            Err(e) => {
                let error = e.to_string();
                match on_fail {
                    OnFail::Keep => {
                        self.unsaved.insert(after.id.clone(), error.clone());
                    }
                    OnFail::Revert => {
                        if let Some(slot) = self.items.iter_mut().find(|r| r.id == before.id) {
                            *slot = before;
                        }
                    }
                }
                Err(error)
            }
        }
    }

    /// Write every unsaved entry again. The first error comes back.
    pub fn retry(&mut self, p: &dyn Persist) -> Result<(), String> {
        let ids: Vec<String> = self.unsaved.keys().cloned().collect();
        let mut first = None;
        for id in ids {
            let Some(rec) = self.get(&id).cloned() else {
                self.unsaved.remove(&id);
                continue;
            };
            match p.save(&rec) {
                Ok(()) => {
                    self.unsaved.remove(&id);
                }
                Err(e) => {
                    let error = e.to_string();
                    self.unsaved.insert(id, error.clone());
                    first.get_or_insert(error);
                }
            }
        }
        first.map_or(Ok(()), Err)
    }

    /// "Delete from this Mac" for a recording the library does not have:
    /// write Discarding (the same guarded write as every transition), then
    /// remove the state file, then the audio, then the entry. A failed state
    /// write leaves both files; a failure after it leaves Discarding on disk,
    /// which `finish_discards` completes at the next start.
    pub fn discard(&mut self, p: &dyn Persist, f: &dyn Files, id: &str, active: bool, now: DateTime<Utc>) -> Result<(), DiscardError> {
        let rec = self.get(id).ok_or(DiscardError::NotDiscardable)?;
        if active || matches!(rec.status, Status::Recording | Status::Uploading) {
            return Err(DiscardError::Busy);
        }
        if !self.is_saved(id) {
            return Err(DiscardError::Unsaved);
        }
        if rec.status != Status::Discarding {
            if !rec.can_save_elsewhere() {
                return Err(DiscardError::NotDiscardable);
            }
            self.apply(p, id, Event::Discard, now, OnFail::Revert).map_err(DiscardError::NotSaved)?;
        }
        f.remove_state(id).map_err(|e| DiscardError::Files(e.to_string()))?;
        f.delete_audio(id).map_err(|e| DiscardError::Files(e.to_string()))?;
        self.items.retain(|r| r.id != id);
        Ok(())
    }

    /// Finish deletions a crash interrupted (entries still Discarding).
    pub fn finish_discards(&mut self, p: &dyn Persist, f: &dyn Files, now: DateTime<Utc>) {
        let ids: Vec<String> = self.items.iter().filter(|r| r.status == Status::Discarding).map(|r| r.id.clone()).collect();
        for id in ids {
            if let Err(e) = self.discard(p, f, &id, false, now) {
                log::warn!("{id}: the interrupted deletion did not finish: {e:?}");
            }
        }
    }

    /// The next upload for a connection: due, of this install and user, and saved.
    pub fn next_upload(&self, c: &select::Connection, now: DateTime<Utc>) -> Option<&RecordingState> {
        self.items
            .iter()
            .filter(|r| self.is_saved(&r.id) && r.due(now) && select::belongs(r, c))
            .min_by_key(|r| r.started_at)
    }

    pub fn status_targets(&self, c: &select::Connection, since: DateTime<Utc>) -> Vec<&RecordingState> {
        select::status_targets(&self.items, c, since).into_iter().filter(|r| self.is_saved(&r.id)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::state::Owner;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// The store, with a switch that makes every write fail as a full disk does.
    struct Flaky {
        store: store::Store,
        fail: AtomicBool,
    }
    impl Persist for Flaky {
        fn save(&self, rec: &RecordingState) -> std::io::Result<()> {
            if self.fail.load(Ordering::SeqCst) {
                // Not OS error 28: Windows calls 28 "the printer is out of paper".
                return Err(std::io::Error::new(std::io::ErrorKind::StorageFull, "No space left on device"));
            }
            self.store.save(rec)
        }
    }

    fn owner() -> Owner {
        Owner { user_id: "u1".into(), email: "u1@example.com".into() }
    }

    #[test]
    fn a_stop_that_cannot_be_written_is_kept_unsaved_replayed_and_not_uploaded_after_a_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Flaky { store: store::Store::new(tmp.path()).unwrap(), fail: AtomicBool::new(false) };
        let mut rec = RecordingState::new("r".into(), "https://a.example".into(), "t".into(), Utc::now());
        rec.owner = Some(owner());
        p.save(&rec).unwrap();
        let mut q = Queue::new(vec![rec]);
        let me = owner();
        let c = select::Connection { host: "https://a.example", user: &me };

        // The disk fills: Stop cannot be written.
        p.fail.store(true, Ordering::SeqCst);
        let stop = Event::Stopped { at: Utc::now(), duration_s: 60, sha256: "aa".into(), size_bytes: 10 };
        assert!(q.apply(&p, "r", stop, Utc::now(), OnFail::Keep).is_err());
        assert_eq!(q.get("r").unwrap().status, Status::Uploading, "the window shows the stop");
        assert!(q.unsaved_error("r").unwrap().contains("No space left"));
        assert!(q.next_upload(&c, Utc::now()).is_none(), "an unsaved entry is not uploaded");
        assert!(q.retry(&p).is_err());

        // The app ends before the disk has room: the file still says Recording.
        let loaded = p.store.load_all();
        assert_eq!(loaded.recordings[0].status, Status::Recording);
        let mut after_restart = loaded.recordings[0].clone();
        after_restart.apply(Event::Recovered { at: Utc::now(), duration_s: 60, sha256: "aa".into(), size_bytes: 10 }, Utc::now());
        let q2 = Queue::new(vec![after_restart]);
        assert!(q2.next_upload(&c, Utc::now()).is_none(), "a recovered recording waits for the user");

        // Without a restart: room again, Retry writes it, and it may upload.
        p.fail.store(false, Ordering::SeqCst);
        q.retry(&p).unwrap();
        assert!(q.is_saved("r"));
        assert_eq!(p.store.read("r").unwrap().status, Status::Uploading);
        assert!(q.next_upload(&c, Utc::now()).is_some());
    }

    #[test]
    fn a_local_failure_that_cannot_be_written_stays_failed_in_memory() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Flaky { store: store::Store::new(tmp.path()).unwrap(), fail: AtomicBool::new(false) };
        let rec = RecordingState::new("r".into(), "h".into(), "t".into(), Utc::now());
        p.save(&rec).unwrap();
        let mut q = Queue::new(vec![rec]);
        p.fail.store(true, Ordering::SeqCst);
        let ev = Event::FailedLocal { at: Utc::now(), error: "No space left on device (os error 28)".into(), duration_s: 5 };
        assert!(q.apply(&p, "r", ev, Utc::now(), OnFail::Keep).is_err());
        assert_eq!(q.get("r").unwrap().status, Status::FailedLocal);
        p.fail.store(false, Ordering::SeqCst);
        q.retry(&p).unwrap();
        assert_eq!(p.store.read("r").unwrap().status, Status::FailedLocal);
    }

    /// Files that refuse to remove the state file.
    struct StuckState<'a>(&'a store::Store);
    impl Files for StuckState<'_> {
        fn remove_state(&self, _: &str) -> std::io::Result<()> {
            Err(std::io::Error::from_raw_os_error(13))
        }
        fn delete_audio(&self, id: &str) -> std::io::Result<()> {
            self.0.delete_audio(id)
        }
    }

    fn waiting(p: &Flaky, id: &str) -> RecordingState {
        let mut rec = RecordingState::new(id.into(), "h".into(), "t".into(), Utc::now());
        rec.owner = Some(owner());
        rec.apply(Event::Stopped { at: Utc::now(), duration_s: 1, sha256: "a".into(), size_bytes: 1 }, Utc::now());
        // Waiting for the network: not uploading now, not in the library.
        rec.apply(Event::AttemptFailed { reason: PendingReason::Network, retry_at: None }, Utc::now());
        p.save(&rec).unwrap();
        std::fs::write(p.store.audio_path(id), b"the only copy").unwrap();
        rec
    }

    #[test]
    fn an_unsaved_entry_is_not_deleted() {
        // The reviewer's sequence: the entry's latest change is not on the disk.
        let tmp = tempfile::tempdir().unwrap();
        let p = Flaky { store: store::Store::new(tmp.path()).unwrap(), fail: AtomicBool::new(false) };
        let rec = waiting(&p, "r");
        let mut q = Queue::new(vec![rec]);
        p.fail.store(true, Ordering::SeqCst);
        let _ = q.apply(&p, "r", Event::TryNow, Utc::now(), OnFail::Keep);
        assert!(!q.is_saved("r"));
        assert_eq!(q.discard(&p, &p.store, "r", false, Utc::now()), Err(DiscardError::Unsaved));
        assert!(p.store.audio_path("r").exists(), "the only copy was deleted");
    }

    #[test]
    fn a_failed_state_write_leaves_both_files() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Flaky { store: store::Store::new(tmp.path()).unwrap(), fail: AtomicBool::new(false) };
        let mut q = Queue::new(vec![waiting(&p, "r")]);
        p.fail.store(true, Ordering::SeqCst);
        assert!(matches!(q.discard(&p, &p.store, "r", false, Utc::now()), Err(DiscardError::NotSaved(_))));
        assert!(p.store.audio_path("r").exists());
        assert_eq!(p.store.read("r").unwrap().status, Status::Pending);
        assert_eq!(q.get("r").unwrap().status, Status::Pending);
    }

    #[test]
    fn a_state_file_that_will_not_go_keeps_the_audio_and_finishes_later() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Flaky { store: store::Store::new(tmp.path()).unwrap(), fail: AtomicBool::new(false) };
        let mut q = Queue::new(vec![waiting(&p, "r")]);
        assert!(matches!(q.discard(&p, &StuckState(&p.store), "r", false, Utc::now()), Err(DiscardError::Files(_))));
        assert!(p.store.audio_path("r").exists(), "the audio went before the metadata");
        assert_eq!(p.store.read("r").unwrap().status, Status::Discarding);
        // Next start: the deletion the user asked for completes.
        let mut q2 = Queue::new(p.store.load_all().recordings);
        q2.finish_discards(&p, &p.store, Utc::now());
        assert!(q2.items.is_empty());
        assert!(!p.store.audio_path("r").exists());
        assert!(p.store.read("r").is_err());
    }

    #[test]
    fn busy_and_uploaded_recordings_are_not_discarded() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Flaky { store: store::Store::new(tmp.path()).unwrap(), fail: AtomicBool::new(false) };
        let rec = waiting(&p, "r");
        let mut q = Queue::new(vec![rec]);
        assert_eq!(q.discard(&p, &p.store, "r", true, Utc::now()), Err(DiscardError::Busy));
        q.items[0].status = Status::Confirmed;
        assert_eq!(q.discard(&p, &p.store, "r", false, Utc::now()), Err(DiscardError::NotDiscardable));
        assert!(p.store.audio_path("r").exists());
    }

    #[test]
    fn a_reverted_change_leaves_the_entry_as_it_was() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Flaky { store: store::Store::new(tmp.path()).unwrap(), fail: AtomicBool::new(true) };
        let mut rec = RecordingState::new("r".into(), "h".into(), "t".into(), Utc::now());
        rec.apply(Event::Stopped { at: Utc::now(), duration_s: 1, sha256: "a".into(), size_bytes: 1 }, Utc::now());
        let mut q = Queue::new(vec![rec.clone()]);
        assert!(q.apply(&p, "r", Event::SavedElsewhere { path: "/x".into() }, Utc::now(), OnFail::Revert).is_err());
        assert_eq!(q.get("r").unwrap(), &rec);
        assert!(q.is_saved("r"));
    }
}
