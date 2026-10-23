//! One recording's local state and the rules that move it, per docs/spec.md
//! "How a recording reaches the library": Recording, Uploading, Pending (no
//! network), Warn (24 h), AskUser (7 d), Confirmed, Deleted (7 d after confirm).
//!
//! Everything here is pure: the uploader and the clock feed it events, and the
//! queue writes the result to the recording's JSON file after every change.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Warn after this long without a confirm.
pub const WARN_AFTER: Duration = Duration::hours(24);
/// Ask the user after this long without a confirm.
pub const ASK_AFTER: Duration = Duration::days(7);
/// Delete the local file this long after the confirm.
pub const KEEP_AFTER_CONFIRM: Duration = Duration::days(7);
/// After "Keep trying", the question comes back after this long.
pub const ASK_AGAIN_AFTER: Duration = Duration::days(7);
/// A file that fails the server's hash or size check this often is refused.
pub const MAX_RESTARTS: u32 = 3;

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
    /// The user saved the file elsewhere after the 7-day question; the queue's copy is gone.
    SavedElsewhere,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordingState {
    /// Local id; also the file name, `<id>.ogg`.
    pub id: String,
    /// The install's origin the recording belongs to.
    pub host: String,
    pub title: String,
    pub started_at: DateTime<Utc>,
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
    #[serde(default)]
    pub saved_to: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<DateTime<Utc>>,
}

/// What happened, from the capture, the uploader, the user or the clock.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The capture stopped; the file is finished and hashed.
    Stopped { at: DateTime<Utc>, duration_s: u64, sha256: String, size_bytes: u64 },
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
    /// The 7-day question: the file was copied to `path` and checked.
    SavedElsewhere { path: String },
    /// The local file was deleted after the 7 days.
    FileDeleted,
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
            stopped_at: None,
            duration_s: 0,
            sha256: None,
            size_bytes: None,
            status: Status::Recording,
            pending_reason: None,
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
            saved_to: None,
            deleted_at: None,
        }
    }

    /// The server does not hold this file yet, and the local copy is still here.
    pub fn is_unconfirmed(&self) -> bool {
        matches!(self.status, Status::Uploading | Status::Pending | Status::Warn | Status::AskUser)
    }

    /// The uploader may start an attempt now.
    pub fn due(&self, now: DateTime<Utc>) -> bool {
        if !self.is_unconfirmed() || self.stopped_at.is_none() {
            return false;
        }
        match &self.pending_reason {
            Some(PendingReason::Rejected { .. }) | Some(PendingReason::SignedOut) => return false,
            _ => {}
        }
        self.next_attempt_at.is_none_or(|at| at <= now)
    }

    /// Time since the recording stopped (or started, for one that never stopped cleanly).
    fn age(&self, now: DateTime<Utc>) -> Duration {
        now - self.stopped_at.unwrap_or(self.started_at)
    }

    /// The unconfirmed status for the recording's age: Pending, Warn or AskUser.
    fn waiting_status(&self, now: DateTime<Utc>) -> Status {
        let age = self.age(now);
        let snoozed = self.ask_snoozed_until.is_some_and(|until| now < until);
        if age >= ASK_AFTER && !snoozed {
            Status::AskUser
        } else if age >= WARN_AFTER {
            Status::Warn
        } else {
            Status::Pending
        }
    }

    pub fn apply(&mut self, event: Event, now: DateTime<Utc>) {
        match event {
            Event::Stopped { at, duration_s, sha256, size_bytes } => {
                if self.status != Status::Recording {
                    return;
                }
                self.stopped_at = Some(at);
                self.duration_s = duration_s;
                self.sha256 = Some(sha256);
                self.size_bytes = Some(size_bytes);
                self.status = Status::Uploading;
                self.next_attempt_at = None;
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
                if matches!(self.status, Status::Recording | Status::Deleted | Status::SavedElsewhere) {
                    return;
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
                    self.status = self.waiting_status(now);
                }
            }
            Event::SavedElsewhere { path } => {
                if self.is_unconfirmed() {
                    self.saved_to = Some(path);
                    self.status = Status::SavedElsewhere;
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

    /// The clock: Pending turns into Warn at 24 hours and AskUser at 7 days; a
    /// confirmed file is due for deletion 7 days after its confirm.
    pub fn tick(&mut self, now: DateTime<Utc>) -> TickOutcome {
        let mut out = TickOutcome::default();
        match self.status {
            Status::Pending | Status::Warn | Status::AskUser => {
                let next = self.waiting_status(now);
                out.ask = next == Status::AskUser && self.status != Status::AskUser;
                self.status = next;
            }
            Status::Confirmed => {
                if let Some(at) = self.confirmed_at {
                    out.delete_file = now - at >= KEEP_AFTER_CONFIRM;
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

    fn stopped() -> RecordingState {
        let mut r = RecordingState::new("r1".into(), "https://h.io".into(), "Plan".into(), t0());
        r.apply(
            Event::Stopped { at: t0() + Duration::hours(1), duration_s: 3600, sha256: "ab".into(), size_bytes: 20_000_000 },
            t0(),
        );
        r
    }

    fn network_failure(r: &mut RecordingState, now: DateTime<Utc>) {
        r.apply(Event::AttemptFailed { reason: PendingReason::Network, retry_at: Some(now + Duration::seconds(2)) }, now);
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
    fn pending_turns_into_warn_after_24_hours_and_ask_after_7_days() {
        let mut r = stopped();
        let stop = r.stopped_at.unwrap();
        network_failure(&mut r, stop);
        assert_eq!(r.tick(stop + Duration::hours(23)), TickOutcome::default());
        assert_eq!(r.status, Status::Pending);
        r.tick(stop + Duration::hours(24));
        assert_eq!(r.status, Status::Warn);
        let out = r.tick(stop + Duration::days(7));
        assert_eq!(r.status, Status::AskUser);
        assert!(out.ask);
        // The question opens once, not on every tick.
        assert!(!r.tick(stop + Duration::days(7) + Duration::minutes(1)).ask);
    }

    #[test]
    fn a_failure_after_24_hours_lands_in_warn_directly() {
        let mut r = stopped();
        let later = r.stopped_at.unwrap() + Duration::hours(30);
        r.apply(Event::AttemptStarted, later);
        assert_eq!(r.status, Status::Uploading);
        network_failure(&mut r, later);
        assert_eq!(r.status, Status::Warn);
    }

    #[test]
    fn keep_trying_snoozes_the_question_for_7_days_and_retries_go_on() {
        let mut r = stopped();
        let ask = r.stopped_at.unwrap() + Duration::days(7);
        network_failure(&mut r, ask);
        assert_eq!(r.status, Status::AskUser);
        r.apply(Event::KeepTrying, ask);
        assert_eq!(r.status, Status::Warn);
        assert!(r.due(ask + Duration::seconds(5)));
        r.tick(ask + Duration::days(6));
        assert_eq!(r.status, Status::Warn);
        assert!(r.tick(ask + Duration::days(7)).ask);
        assert_eq!(r.status, Status::AskUser);
    }

    #[test]
    fn nothing_is_deleted_without_a_confirm() {
        let mut r = stopped();
        network_failure(&mut r, t0());
        for days in [1, 7, 30, 365] {
            let out = r.tick(t0() + Duration::days(days));
            assert!(!out.delete_file);
            assert!(r.is_unconfirmed());
        }
        // FileDeleted is ignored for an unconfirmed recording.
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
    fn a_confirmed_file_is_deleted_7_days_after_the_confirm() {
        let mut r = stopped();
        r.apply(Event::Created { recording_id: "s1".into(), meeting_id: "m1".into(), chunk_size_bytes: 8_388_608, chunk_count: Some(3), upload_url: "/u".into() }, t0());
        let at = t0() + Duration::hours(2);
        r.apply(Event::Confirmed { at }, at);
        assert_eq!(r.status, Status::Confirmed);
        assert_eq!(r.progress(), (3, 3));
        assert!(!r.tick(at + Duration::days(6)).delete_file);
        assert!(r.tick(at + Duration::days(7)).delete_file);
        r.apply(Event::FileDeleted, at + Duration::days(7));
        assert_eq!(r.status, Status::Deleted);
        assert_eq!(r.deleted_at, Some(at + Duration::days(7)));
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
            r.apply(Event::Created { recording_id: format!("s{n}"), meeting_id: "m".into(), chunk_size_bytes: 8_388_608, chunk_count: Some(3), upload_url: "/u".into() }, t0());
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
    fn the_state_file_round_trips() {
        let mut r = stopped();
        r.apply(Event::Created { recording_id: "s1".into(), meeting_id: "m1".into(), chunk_size_bytes: 8_388_608, chunk_count: Some(3), upload_url: "/u".into() }, t0());
        r.apply(Event::ChunksReceived(vec![1]), t0());
        network_failure(&mut r, t0());
        let json = serde_json::to_string_pretty(&r).unwrap();
        assert!(json.contains("\"status\": \"pending\""));
        assert!(json.contains("\"kind\": \"network\""));
        let back: RecordingState = serde_json::from_str(&json).unwrap();
        assert_eq!(back, r);
    }
}
