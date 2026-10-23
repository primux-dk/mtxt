//! One recording's local state and the rules that move it, per docs/spec.md
//! "How a recording reaches the library": Recording, Uploading, Pending (no
//! network), Warn (24 h), AskUser (7 d), Confirmed, Deleted (7 d after confirm).
//! Two local states keep a file the recorder could not finish or read:
//! FailedLocal (a write failed during capture) and Unreadable (recovery could
//! not read it). Neither is uploaded or deleted without the user.
//!
//! Everything here is pure: the uploader and the clock feed it events, and the
//! queue writes the result to the recording's JSON file after every change.
//!
//! Time rules are conservative about the clock. A step that waits for days
//! (the 24-hour warning, the 7-day question, the deletion 7 days after the
//! confirm) needs both the wall-clock time and as many calendar days on which
//! the app ran (`days_seen`). A clock that moves backwards advances nothing.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Warn after this long without a confirm, and at least one more calendar day seen.
pub const WARN_AFTER: Duration = Duration::hours(24);
pub const WARN_DAYS: u32 = 1;
/// Ask the user after this long without a confirm, and 7 calendar days seen.
pub const ASK_AFTER: Duration = Duration::days(7);
pub const ASK_DAYS: u32 = 7;
/// Delete the local file this long after the confirm, and 7 calendar days seen.
pub const KEEP_AFTER_CONFIRM: Duration = Duration::days(7);
pub const KEEP_DAYS: u32 = 7;
/// After "Keep trying", the question comes back after this long (and as many days).
pub const ASK_AGAIN_AFTER: Duration = Duration::days(7);
/// A file that fails the server's hash or size check this often is refused.
pub const MAX_RESTARTS: u32 = 3;
/// A retry time further ahead than this means the clock went back; retry now.
pub const MAX_RETRY_AHEAD: Duration = Duration::minutes(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Capture is running and the file grows.
    Recording,
    /// Waiting for, or in, an upload attempt.
    Uploading,
    /// The last attempt failed; the uploader tries again at `next_attempt_at`.
    Pending,
    /// Not confirmed 24 hours after the recording stopped. Still retrying.
    Warn,
    /// Not confirmed 7 days after it stopped; the window asks what to do. Still retrying.
    AskUser,
    /// The server holds the whole file and its hash matched.
    Confirmed,
    /// The local file was deleted 7 days after the confirm.
    Deleted,
    /// The user saved the file elsewhere; the queue's copy is gone.
    SavedElsewhere,
    /// Writing the file failed during capture (`local_error`). The partial file is kept.
    FailedLocal,
    /// The file could not be read back (`local_error`). Both files are kept.
    Unreadable,
    /// The user deleted a recording the library does not have; written before
    /// any file goes, so a crash half-way finishes the deletion it asked for.
    Discarding,
}

/// Why the last attempt did not finish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PendingReason {
    /// No connection to the install.
    Network,
    /// The install answered 5xx or something unexpected; retry later.
    Server,
    /// The token was refused (401). Uploads wait for a new connection.
    SignedOut,
    /// The server refused the file for good (`code` from the contract). No automatic retry.
    Rejected { code: String },
}

/// The library user the recording belongs to: who was connected when it was
/// recorded. Only that user's token uploads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    pub user_id: String,
    pub email: String,
}

/// A stretch where a source delivered nothing (device unplugged, lost), in
/// seconds from the start. The file has silence there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gap {
    /// `microphone` or `system_audio`.
    pub source: String,
    pub from_s: f64,
    pub to_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordingState {
    /// Local id; also the file name, `<id>.ogg`.
    pub id: String,
    /// The install's origin the recording belongs to.
    pub host: String,
    pub title: String,
    pub started_at: DateTime<Utc>,
    /// None for a recording found on disk without its state (recovered): the
    /// user uploads it as themselves, or saves it elsewhere.
    #[serde(default)]
    pub owner: Option<Owner>,
    #[serde(default)]
    pub stopped_at: Option<DateTime<Utc>>,
    /// Seconds of audio.
    #[serde(default)]
    pub duration_s: u64,
    /// Lowercase hex SHA-256 of the finished file.
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    pub status: Status,
    #[serde(default)]
    pub pending_reason: Option<PendingReason>,
    /// The OS error for FailedLocal and Unreadable.
    #[serde(default)]
    pub local_error: Option<String>,
    /// Found on disk without a state file.
    #[serde(default)]
    pub recovered: bool,
    /// Finished by recovery after the app ended during a recording. Whether
    /// the end was clean is unknown, so it uploads only after the user says so.
    #[serde(default)]
    pub needs_review: bool,
    #[serde(default)]
    pub gaps: Vec<Gap>,
    /// The server's recording id once `POST /recordings` answered.
    #[serde(default)]
    pub server_recording_id: Option<String>,
    #[serde(default)]
    pub server_meeting_id: Option<String>,
    /// From the create response; chunk n holds bytes (n-1) × chunk_size onwards.
    #[serde(default)]
    pub chunk_size_bytes: Option<u64>,
    #[serde(default)]
    pub chunk_count: Option<u64>,
    /// From the create response: where chunk n goes, with `/{n}` appended.
    #[serde(default)]
    pub upload_url: Option<String>,
    /// Chunk numbers the server has acknowledged, ascending.
    #[serde(default)]
    pub chunks_received: Vec<u64>,
    #[serde(default)]
    pub confirmed_at: Option<DateTime<Utc>>,
    /// The server's own status after the confirm (`transcribing`, `transcribed`, `failed`).
    #[serde(default)]
    pub server_status: Option<String>,
    /// Failed attempts in a row; drives the backoff.
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub next_attempt_at: Option<DateTime<Utc>>,
    /// Times the server failed the whole file (hash, size, expired session) and the upload restarted.
    #[serde(default)]
    pub restarts: u32,
    #[serde(default)]
    pub ask_snoozed_until: Option<DateTime<Utc>>,
    /// `days_seen` when the user chose "Keep trying".
    #[serde(default)]
    pub days_at_snooze: Option<u32>,
    /// Calendar days the app ran since the stop, or since the confirm once confirmed.
    #[serde(default)]
    pub days_seen: u32,
    /// The latest clock reading the rules accepted.
    #[serde(default)]
    pub last_tick: Option<DateTime<Utc>>,
    #[serde(default)]
    pub saved_to: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<DateTime<Utc>>,
}

/// What happened, from the capture, the uploader, the user or the clock.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The capture stopped (or recovery read the file); it is finished and hashed.
    Stopped { at: DateTime<Utc>, duration_s: u64, sha256: String, size_bytes: u64 },
    /// Recovery read a file the app left in Recording: queued, but held for the user.
    Recovered { at: DateTime<Utc>, duration_s: u64, sha256: String, size_bytes: u64 },
    /// The user uploads a recovered recording.
    Review,
    /// A write failed during capture: the partial file stays, nothing is uploaded.
    FailedLocal { at: DateTime<Utc>, error: String, duration_s: u64 },
    /// Recovery could not read the file; both files stay.
    Unreadable { error: String },
    /// Silence where a source was lost.
    Gaps(Vec<Gap>),
    /// The user uploads a recovered recording as the connected user.
    Claim(Owner),
    /// `POST /recordings` answered.
    Created {
        recording_id: String,
        meeting_id: String,
        chunk_size_bytes: u64,
        chunk_count: Option<u64>,
        upload_url: String,
    },
    /// The server's list of chunks it holds, from a receipt or a GET.
    ChunksReceived(Vec<u64>),
    AttemptStarted,
    /// The attempt failed; try again at `retry_at` (None for a rejection).
    AttemptFailed { reason: PendingReason, retry_at: Option<DateTime<Utc>> },
    /// The server failed the whole file or lost the session; start again with a new create.
    Restart,
    Confirmed { at: DateTime<Utc> },
    ServerStatus(String),
    /// A new token: uploads that waited for one may go again.
    Reconnected,
    /// "Try now".
    TryNow,
    /// The 7-day question: "Keep trying".
    KeepTrying,
    /// The file was copied to `path`, synced and checked.
    SavedElsewhere { path: String },
    /// The local file was deleted after the 7 days.
    FileDeleted,
    /// "Delete from this Mac" on a recording the library does not have.
    Discard,
}

/// What the clock asks the queue to do.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TickOutcome {
    /// The 7 days after the confirm are over: delete the local file, then send `FileDeleted`.
    pub delete_file: bool,
    /// The 7-day question opened just now.
    pub ask: bool,
}

impl RecordingState {
    pub fn new(id: String, host: String, title: String, started_at: DateTime<Utc>) -> Self {
        RecordingState {
            id,
            host,
            title,
            started_at,
            owner: None,
            stopped_at: None,
            duration_s: 0,
            sha256: None,
            size_bytes: None,
            status: Status::Recording,
            pending_reason: None,
            local_error: None,
            recovered: false,
            needs_review: false,
            gaps: Vec::new(),
            server_recording_id: None,
            server_meeting_id: None,
            chunk_size_bytes: None,
            chunk_count: None,
            upload_url: None,
            chunks_received: Vec::new(),
            confirmed_at: None,
            server_status: None,
            attempts: 0,
            next_attempt_at: None,
            restarts: 0,
            ask_snoozed_until: None,
            days_at_snooze: None,
            days_seen: 0,
            last_tick: None,
            saved_to: None,
            deleted_at: None,
        }
    }

    /// The server does not hold this file yet, and the local copy is still here.
    pub fn is_unconfirmed(&self) -> bool {
        matches!(self.status, Status::Uploading | Status::Pending | Status::Warn | Status::AskUser)
    }

    /// The local file is still here and not in the library: the user may save it elsewhere.
    pub fn can_save_elsewhere(&self) -> bool {
        self.is_unconfirmed() || matches!(self.status, Status::FailedLocal | Status::Unreadable)
    }

    /// The uploader may start an attempt now. The caller checks the owner and the host.
    pub fn due(&self, now: DateTime<Utc>) -> bool {
        if !self.is_unconfirmed() || self.stopped_at.is_none() || self.owner.is_none() || self.needs_review {
            return false;
        }
        match &self.pending_reason {
            Some(PendingReason::Rejected { .. }) | Some(PendingReason::SignedOut) => return false,
            _ => {}
        }
        self.next_attempt_at.is_none_or(|at| at <= now || at - now > MAX_RETRY_AHEAD)
    }

    fn age(&self, now: DateTime<Utc>) -> Duration {
        now - self.stopped_at.unwrap_or(self.started_at)
    }

    /// The unconfirmed status for the recording's age: Pending, Warn or AskUser.
    fn waiting_status(&self, now: DateTime<Utc>) -> Status {
        let age = self.age(now);
        let snoozed = self.ask_snoozed_until.is_some_and(|until| now < until)
            || self.days_at_snooze.is_some_and(|d| self.days_seen < d + ASK_DAYS);
        if age >= ASK_AFTER && self.days_seen >= ASK_DAYS && !snoozed {
            Status::AskUser
        } else if age >= WARN_AFTER && self.days_seen >= WARN_DAYS {
            Status::Warn
        } else {
            Status::Pending
        }
    }

    /// Start counting days from `at`.
    fn restart_days(&mut self, at: DateTime<Utc>) {
        self.days_seen = 0;
        self.days_at_snooze = None;
        self.last_tick = Some(at);
    }

    pub fn apply(&mut self, event: Event, now: DateTime<Utc>) {
        match event {
            Event::Stopped { at, duration_s, sha256, size_bytes } => {
                if !matches!(self.status, Status::Recording | Status::Unreadable) {
                    return;
                }
                self.stopped_at = Some(at);
                self.duration_s = duration_s;
                self.sha256 = Some(sha256);
                self.size_bytes = Some(size_bytes);
                self.local_error = None;
                self.status = Status::Uploading;
                self.next_attempt_at = None;
                self.restart_days(at);
            }
            Event::Recovered { at, duration_s, sha256, size_bytes } => {
                if !matches!(self.status, Status::Recording | Status::Unreadable) {
                    return;
                }
                self.status = Status::Recording;
                self.apply(Event::Stopped { at, duration_s, sha256, size_bytes }, now);
                self.needs_review = true;
            }
            Event::Review => self.needs_review = false,
            Event::FailedLocal { at, error, duration_s } => {
                if self.status != Status::Recording {
                    return;
                }
                self.stopped_at = Some(at);
                self.duration_s = duration_s;
                self.local_error = Some(error);
                self.status = Status::FailedLocal;
            }
            Event::Unreadable { error } => {
                if matches!(self.status, Status::Deleted | Status::SavedElsewhere | Status::Confirmed) {
                    return;
                }
                self.local_error = Some(error);
                self.status = Status::Unreadable;
            }
            Event::Gaps(gaps) => self.gaps.extend(gaps),
            Event::Claim(owner) => {
                if self.owner.is_none() {
                    self.owner = Some(owner);
                    self.needs_review = false;
                    self.next_attempt_at = None;
                }
            }
            Event::Created { recording_id, meeting_id, chunk_size_bytes, chunk_count, upload_url } => {
                self.server_recording_id = Some(recording_id);
                self.upload_url = Some(upload_url);
                self.server_meeting_id = Some(meeting_id);
                self.chunk_size_bytes = Some(chunk_size_bytes);
                self.chunk_count = chunk_count.or_else(|| {
                    self.size_bytes.map(|size| super::chunks::chunk_count(size, chunk_size_bytes))
                });
                self.chunks_received.clear();
            }
            Event::ChunksReceived(mut list) => {
                list.sort_unstable();
                list.dedup();
                self.chunks_received = list;
            }
            Event::AttemptStarted => {
                if self.is_unconfirmed() {
                    self.status = Status::Uploading;
                }
            }
            Event::AttemptFailed { reason, retry_at } => {
                if !self.is_unconfirmed() {
                    return;
                }
                self.attempts = self.attempts.saturating_add(1);
                self.next_attempt_at = retry_at;
                self.pending_reason = Some(reason);
                self.status = self.waiting_status(now);
            }
            Event::Restart => {
                self.restarts = self.restarts.saturating_add(1);
                self.server_recording_id = None;
                self.server_meeting_id = None;
                self.chunk_size_bytes = None;
                self.chunk_count = None;
                self.upload_url = None;
                self.chunks_received.clear();
                if self.restarts >= MAX_RESTARTS {
                    self.apply(
                        Event::AttemptFailed {
                            reason: PendingReason::Rejected { code: "hash_mismatch".into() },
                            retry_at: None,
                        },
                        now,
                    );
                }
            }
            Event::Confirmed { at } => {
                if !self.is_unconfirmed() && self.status != Status::Confirmed {
                    return;
                }
                if self.status != Status::Confirmed {
                    self.restart_days(now);
                }
                self.status = Status::Confirmed;
                self.confirmed_at.get_or_insert(at);
                self.pending_reason = None;
                self.next_attempt_at = None;
                self.attempts = 0;
                if let Some(count) = self.chunk_count {
                    self.chunks_received = (1..=count).collect();
                }
            }
            Event::ServerStatus(status) => {
                self.server_status = Some(status);
            }
            Event::Reconnected => {
                if self.pending_reason == Some(PendingReason::SignedOut) {
                    self.pending_reason = None;
                    self.next_attempt_at = None;
                    self.attempts = 0;
                }
            }
            Event::TryNow => {
                if self.is_unconfirmed() {
                    self.next_attempt_at = None;
                    self.attempts = 0;
                    if let Some(PendingReason::Rejected { .. }) = self.pending_reason {
                        self.pending_reason = None;
                        self.restarts = 0;
                    }
                }
            }
            Event::KeepTrying => {
                if self.status == Status::AskUser {
                    self.ask_snoozed_until = Some(now + ASK_AGAIN_AFTER);
                    self.days_at_snooze = Some(self.days_seen);
                    self.status = self.waiting_status(now);
                }
            }
            Event::SavedElsewhere { path } => {
                if self.can_save_elsewhere() {
                    self.saved_to = Some(path);
                    self.status = Status::SavedElsewhere;
                    self.next_attempt_at = None;
                }
            }
            Event::Discard => {
                if self.can_save_elsewhere() {
                    self.status = Status::Discarding;
                    self.next_attempt_at = None;
                }
            }
            Event::FileDeleted => {
                if self.status == Status::Confirmed {
                    self.status = Status::Deleted;
                    self.deleted_at = Some(now);
                }
            }
        }
    }

    /// The clock. A reading earlier than the last accepted one changes
    /// nothing. A reading on a new calendar day counts one day seen. Then
    /// Pending turns into Warn and AskUser, and a confirmed file becomes due
    /// for deletion, when both the wall clock and the days seen allow it.
    pub fn tick(&mut self, now: DateTime<Utc>) -> TickOutcome {
        let mut out = TickOutcome::default();
        if self.status == Status::Recording {
            return out;
        }
        match self.last_tick {
            Some(last) if now < last => return out,
            Some(last) if now.date_naive() > last.date_naive() => {
                self.days_seen = self.days_seen.saturating_add(1);
                self.last_tick = Some(now);
            }
            Some(_) => self.last_tick = Some(now),
            None => self.last_tick = Some(now),
        }
        match self.status {
            Status::Pending | Status::Warn | Status::AskUser => {
                let next = self.waiting_status(now);
                out.ask = next == Status::AskUser && self.status != Status::AskUser;
                self.status = next;
            }
            Status::Confirmed => {
                if let Some(at) = self.confirmed_at {
                    out.delete_file = now - at >= KEEP_AFTER_CONFIRM && self.days_seen >= KEEP_DAYS;
                }
            }
            _ => {}
        }
        out
    }

    /// Chunks done and the total, for "Uploading 2/5".
    pub fn progress(&self) -> (u64, u64) {
        let total = self.chunk_count.unwrap_or_else(|| {
            self.size_bytes.map(|s| super::chunks::chunk_count(s, super::chunks::CHUNK_SIZE)).unwrap_or(0)
        });
        (self.chunks_received.len() as u64, total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 23, 9, 0, 0).unwrap()
    }

    fn owner() -> Owner {
        Owner { user_id: "u1".into(), email: "mette.lund@example.com".into() }
    }

    fn stopped() -> RecordingState {
        let mut r = RecordingState::new("r1".into(), "https://h.io".into(), "Plan".into(), t0());
        r.owner = Some(owner());
        r.apply(
            Event::Stopped { at: t0() + Duration::hours(1), duration_s: 3600, sha256: "ab".into(), size_bytes: 20_000_000 },
            t0(),
        );
        r
    }

    fn network_failure(r: &mut RecordingState, now: DateTime<Utc>) {
        r.apply(Event::AttemptFailed { reason: PendingReason::Network, retry_at: Some(now + Duration::seconds(2)) }, now);
    }

    /// The app runs once an hour from `from` for `hours` hours.
    fn run_hourly(r: &mut RecordingState, from: DateTime<Utc>, hours: i64) -> Vec<TickOutcome> {
        (0..=hours).map(|h| r.tick(from + Duration::hours(h))).collect()
    }

    #[test]
    fn a_stopped_recording_is_queued_for_upload() {
        let r = stopped();
        assert_eq!(r.status, Status::Uploading);
        assert!(r.due(t0()));
        assert_eq!(r.progress(), (0, 3));
    }

    #[test]
    fn a_recording_still_capturing_is_not_uploaded() {
        let r = RecordingState::new("r".into(), "h".into(), "t".into(), t0());
        assert!(!r.due(t0()));
        assert!(!r.is_unconfirmed());
    }

    #[test]
    fn a_recording_without_an_owner_waits_for_a_claim() {
        let mut r = stopped();
        r.owner = None;
        assert!(!r.due(t0()));
        r.apply(Event::Claim(owner()), t0());
        assert!(r.due(t0()));
        // A claim never replaces an owner.
        r.apply(Event::Claim(Owner { user_id: "u2".into(), email: "x@example.com".into() }), t0());
        assert_eq!(r.owner, Some(owner()));
    }

    #[test]
    fn a_failure_waits_for_the_retry_time() {
        let mut r = stopped();
        let now = t0() + Duration::hours(2);
        r.apply(Event::AttemptStarted, now);
        network_failure(&mut r, now);
        assert_eq!(r.status, Status::Pending);
        assert_eq!(r.pending_reason, Some(PendingReason::Network));
        assert!(!r.due(now));
        assert!(r.due(now + Duration::seconds(2)));
        assert_eq!(r.attempts, 1);
    }

    #[test]
    fn a_retry_time_far_ahead_means_the_clock_went_back() {
        let mut r = stopped();
        let now = t0() + Duration::hours(2);
        network_failure(&mut r, now);
        // The clock goes back a day: the 2-second retry is now a day away.
        assert!(r.due(now - Duration::days(1)));
    }

    #[test]
    fn pending_turns_into_warn_and_ask_with_wall_time_and_days_seen() {
        let mut r = stopped();
        let stop = r.stopped_at.unwrap();
        network_failure(&mut r, stop);
        run_hourly(&mut r, stop, 23);
        assert_eq!(r.status, Status::Pending);
        run_hourly(&mut r, stop + Duration::hours(23), 1);
        assert_eq!(r.status, Status::Warn);
        let outs = run_hourly(&mut r, stop + Duration::hours(24), 6 * 24);
        assert_eq!(r.status, Status::AskUser);
        assert_eq!(outs.iter().filter(|o| o.ask).count(), 1, "the question opens once");
    }

    #[test]
    fn a_clock_jump_forward_does_not_warn_ask_or_delete() {
        let mut r = stopped();
        let stop = r.stopped_at.unwrap();
        network_failure(&mut r, stop);
        // The clock jumps 30 days ahead: one new calendar day, not seven.
        let out = r.tick(stop + Duration::days(30));
        assert!(!out.ask);
        assert_eq!(r.status, Status::Warn);
        let mut c = stopped();
        c.apply(Event::Confirmed { at: t0() + Duration::hours(2) }, t0() + Duration::hours(2));
        assert!(!c.tick(t0() + Duration::days(30)).delete_file);
        assert_eq!(c.status, Status::Confirmed);
    }

    #[test]
    fn a_clock_jump_backwards_advances_nothing() {
        let mut r = stopped();
        let stop = r.stopped_at.unwrap();
        network_failure(&mut r, stop);
        run_hourly(&mut r, stop, 48);
        let before = r.clone();
        assert_eq!(r.tick(stop - Duration::days(3)), TickOutcome::default());
        assert_eq!(r, before);
    }

    #[test]
    fn a_failure_after_24_hours_lands_in_warn_directly() {
        let mut r = stopped();
        let stop = r.stopped_at.unwrap();
        run_hourly(&mut r, stop, 30);
        let later = stop + Duration::hours(30);
        r.apply(Event::AttemptStarted, later);
        assert_eq!(r.status, Status::Uploading);
        network_failure(&mut r, later);
        assert_eq!(r.status, Status::Warn);
    }

    #[test]
    fn keep_trying_snoozes_the_question_for_7_days_and_retries_go_on() {
        let mut r = stopped();
        let stop = r.stopped_at.unwrap();
        network_failure(&mut r, stop);
        run_hourly(&mut r, stop, 7 * 24);
        assert_eq!(r.status, Status::AskUser);
        let ask = stop + Duration::days(7);
        r.apply(Event::KeepTrying, ask);
        assert_eq!(r.status, Status::Warn);
        assert!(r.due(ask + Duration::seconds(5)));
        run_hourly(&mut r, ask, 6 * 24);
        assert_eq!(r.status, Status::Warn);
        let outs = run_hourly(&mut r, ask + Duration::days(6), 24);
        assert!(outs.iter().any(|o| o.ask));
        assert_eq!(r.status, Status::AskUser);
    }

    #[test]
    fn nothing_is_deleted_without_a_confirm() {
        let mut r = stopped();
        network_failure(&mut r, t0());
        for out in run_hourly(&mut r, t0(), 400 * 24 / 10) {
            assert!(!out.delete_file);
        }
        assert!(r.is_unconfirmed());
        r.apply(Event::FileDeleted, t0());
        assert!(r.is_unconfirmed());
    }

    #[test]
    fn saved_elsewhere_ends_the_queue_entry() {
        let mut r = stopped();
        r.apply(Event::SavedElsewhere { path: "/Users/x/Desktop/plan.ogg".into() }, t0());
        assert_eq!(r.status, Status::SavedElsewhere);
        assert!(!r.due(t0()));
    }

    #[test]
    fn a_confirmed_file_is_deleted_after_7_days_and_7_days_seen() {
        let mut r = stopped();
        r.apply(
            Event::Created {
                recording_id: "s1".into(),
                meeting_id: "m1".into(),
                chunk_size_bytes: 8_388_608,
                chunk_count: Some(3),
                upload_url: "/u".into(),
            },
            t0(),
        );
        let at = t0() + Duration::hours(2);
        r.apply(Event::Confirmed { at }, at);
        assert_eq!(r.status, Status::Confirmed);
        assert_eq!(r.progress(), (3, 3));
        let outs = run_hourly(&mut r, at, 7 * 24 - 1);
        assert!(outs.iter().all(|o| !o.delete_file));
        assert!(r.tick(at + Duration::days(7)).delete_file);
        r.apply(Event::FileDeleted, at + Duration::days(7));
        assert_eq!(r.status, Status::Deleted);
    }

    #[test]
    fn the_first_confirm_time_is_kept() {
        let mut r = stopped();
        r.apply(Event::Confirmed { at: t0() }, t0());
        r.apply(Event::Confirmed { at: t0() + Duration::days(3) }, t0());
        assert_eq!(r.confirmed_at, Some(t0()));
    }

    #[test]
    fn signed_out_waits_for_a_reconnect() {
        let mut r = stopped();
        r.apply(Event::AttemptFailed { reason: PendingReason::SignedOut, retry_at: None }, t0());
        assert!(!r.due(t0() + Duration::days(1)));
        r.apply(Event::Reconnected, t0());
        assert!(r.due(t0()));
    }

    #[test]
    fn a_rejection_waits_for_try_now() {
        let mut r = stopped();
        r.apply(Event::AttemptFailed { reason: PendingReason::Rejected { code: "too_large".into() }, retry_at: None }, t0());
        assert!(!r.due(t0() + Duration::days(1)));
        r.apply(Event::TryNow, t0());
        assert!(r.due(t0()));
        assert_eq!(r.pending_reason, None);
    }

    #[test]
    fn restarts_clear_the_session_and_stop_after_three() {
        let mut r = stopped();
        for n in 1..=MAX_RESTARTS {
            r.apply(
                Event::Created {
                    recording_id: format!("s{n}"),
                    meeting_id: "m".into(),
                    chunk_size_bytes: 8_388_608,
                    chunk_count: Some(3),
                    upload_url: "/u".into(),
                },
                t0(),
            );
            r.apply(Event::ChunksReceived(vec![2, 1, 1]), t0());
            assert_eq!(r.chunks_received, vec![1, 2]);
            r.apply(Event::Restart, t0());
            assert_eq!(r.server_recording_id, None);
            assert!(r.chunks_received.is_empty());
        }
        assert_eq!(r.pending_reason, Some(PendingReason::Rejected { code: "hash_mismatch".into() }));
        assert!(!r.due(t0()));
    }

    #[test]
    fn a_local_write_failure_keeps_the_file_and_never_uploads() {
        let mut r = RecordingState::new("r".into(), "h".into(), "t".into(), t0());
        r.owner = Some(owner());
        r.apply(Event::FailedLocal { at: t0(), error: "No space left on device (os error 28)".into(), duration_s: 600 }, t0());
        assert_eq!(r.status, Status::FailedLocal);
        assert!(!r.due(t0()) && r.can_save_elsewhere());
        assert!(!r.tick(t0() + Duration::days(30)).delete_file);
        r.apply(Event::SavedElsewhere { path: "/x.ogg".into() }, t0());
        assert_eq!(r.status, Status::SavedElsewhere);
    }

    #[test]
    fn an_unreadable_file_waits_and_can_be_read_again() {
        let mut r = RecordingState::new("r".into(), "h".into(), "t".into(), t0());
        r.owner = Some(owner());
        r.apply(Event::Unreadable { error: "Permission denied (os error 13)".into() }, t0());
        assert_eq!(r.status, Status::Unreadable);
        assert!(!r.due(t0()) && r.can_save_elsewhere());
        r.apply(Event::Stopped { at: t0(), duration_s: 60, sha256: "aa".into(), size_bytes: 10 }, t0());
        assert_eq!(r.status, Status::Uploading);
        assert_eq!(r.local_error, None);
    }

    #[test]
    fn a_recovered_recording_waits_for_the_user() {
        let mut r = RecordingState::new("r".into(), "h".into(), "t".into(), t0());
        r.owner = Some(owner());
        r.apply(Event::Recovered { at: t0(), duration_s: 60, sha256: "aa".into(), size_bytes: 10 }, t0());
        assert_eq!(r.status, Status::Uploading);
        assert!(r.needs_review && !r.due(t0()));
        r.apply(Event::Review, t0());
        assert!(r.due(t0()));
    }

    #[test]
    fn the_state_file_round_trips_and_old_files_still_read() {
        let mut r = stopped();
        r.apply(Event::Gaps(vec![Gap { source: "microphone".into(), from_s: 61.0, to_s: 64.5 }]), t0());
        network_failure(&mut r, t0());
        let json = serde_json::to_string_pretty(&r).unwrap();
        assert!(json.contains("\"status\": \"pending\""));
        assert!(json.contains("\"kind\": \"network\""));
        let back: RecordingState = serde_json::from_str(&json).unwrap();
        assert_eq!(back, r);
        let old = r#"{"id":"a","host":"h","title":"t","started_at":"2026-10-23T09:00:00Z","status":"uploading"}"#;
        let old: RecordingState = serde_json::from_str(old).unwrap();
        assert_eq!(old.owner, None);
    }
}
