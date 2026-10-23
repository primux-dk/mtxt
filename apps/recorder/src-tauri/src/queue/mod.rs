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
                return Err(std::io::Error::from_raw_os_error(28));
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
