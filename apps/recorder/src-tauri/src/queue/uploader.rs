//! One upload attempt for one recording, per the spec's sequence: create (or
//! resume from the server's `chunks_received`), PUT the missing 8 MiB chunks,
//! complete with the SHA-256 and the size. Every step that changes the state
//! calls `changed`, which writes the state file, so a crash resumes from there.

use super::backoff;
use super::chunks;
use super::state::{Event, PendingReason, RecordingState};
use crate::api::{Api, ApiError};
use crate::contract::{self, CompleteRecordingRequest, CreateRecordingRequest, NewMeeting};
use chrono::{DateTime, Duration, Utc};
use std::path::Path;

/// How the attempt ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Confirmed,
    /// Failed; the state says why and when to try again.
    Failed,
    /// The server dropped the whole file; the state is reset and may go again at once.
    Restarted,
    /// A state write failed; the attempt stopped before its next request.
    NotSaved,
}

/// Writes the recording's state; an error stops the attempt before the next request.
pub type Persist<'a> = dyn FnMut(&RecordingState) -> Result<(), String> + Send + 'a;

/// Waits on `busy` before a chunk counts as failed.
const MAX_BUSY_WAITS: u32 = 60;
/// `missing_chunks` answers to complete before the attempt gives up.
const MAX_COMPLETE_ROUNDS: u32 = 3;

pub async fn attempt(
    rec: &mut RecordingState,
    api: &Api,
    token: &str,
    file: &Path,
    changed: &mut Persist<'_>,
) -> Outcome {
    rec.apply(Event::AttemptStarted, Utc::now());
    // Nothing goes to the server unless the state that leads to it is on the disk.
    if changed(rec).is_err() {
        return Outcome::NotSaved;
    }
    match run(rec, api, token, file, changed).await {
        Ok(outcome) => outcome,
        Err(Stop::NotSaved) => Outcome::NotSaved,
        Err(step) => {
            let now = Utc::now();
            let (reason, retry) = classify(&step);
            let retry_at = retry.then(|| now + backoff_after(rec.attempts + 1));
            rec.apply(Event::AttemptFailed { reason, retry_at }, now);
            if changed(rec).is_err() {
                return Outcome::NotSaved;
            }
            Outcome::Failed
        }
    }
}

fn backoff_after(attempt: u32) -> Duration {
    Duration::from_std(backoff::delay(attempt, backoff::random_jitter())).unwrap_or(Duration::seconds(300))
}

/// Why a step stopped the attempt.
#[derive(Debug)]
enum Stop {
    Api(ApiError),
    /// The local file is gone or no longer matches its hash.
    File(String),
    /// A state write failed.
    NotSaved,
}

impl From<ApiError> for Stop {
    fn from(e: ApiError) -> Self {
        Stop::Api(e)
    }
}

fn classify(stop: &Stop) -> (PendingReason, bool) {
    match stop {
        Stop::File(code) => (PendingReason::Rejected { code: code.clone() }, false),
        Stop::NotSaved => (PendingReason::Server, false),
        Stop::Api(ApiError::Network(_)) => (PendingReason::Network, true),
        Stop::Api(ApiError::Unauthorized) => (PendingReason::SignedOut, false),
        Stop::Api(e) if e.is_retryable() => (PendingReason::Server, true),
        Stop::Api(ApiError::Status { code, .. }) => (PendingReason::Rejected { code: code.clone() }, false),
        Stop::Api(ApiError::Conflict(c)) => (PendingReason::Server, c.reason == "busy"),
        Stop::Api(_) => (PendingReason::Server, true),
    }
}

async fn run(
    rec: &mut RecordingState,
    api: &Api,
    token: &str,
    file: &Path,
    changed: &mut Persist<'_>,
) -> Result<Outcome, Stop> {
    let (sha256, size) = match (&rec.sha256, rec.size_bytes) {
        (Some(h), Some(s)) => (h.clone(), s),
        _ => return Err(Stop::File("file_missing".into())),
    };
    match std::fs::metadata(file) {
        Ok(m) if m.len() == size => {}
        Ok(_) => return Err(Stop::File("file_changed".into())),
        Err(_) => return Err(Stop::File("file_missing".into())),
    }

    // Resume: ask the server what it holds.
    if let Some(id) = rec.server_recording_id.clone() {
        match api.get(token, &id).await {
            // `confirmed_at` first: a recording the server verified is never
            // sent again, even when its transcription failed afterwards.
            Ok(r) if r.confirmed_at.is_some() => {
                return Ok(confirmed(rec, r.confirmed_at.as_deref(), &r.status, changed));
            }
            Ok(r) => match r.status.as_str() {
                contract::status::UPLOADING => {
                    rec.apply(Event::ChunksReceived(r.chunks_received), Utc::now());
                    changed(rec).map_err(|_| Stop::NotSaved)?;
                }
                contract::status::FAILED => return Ok(restart(rec, changed)),
                _ => return Ok(confirmed(rec, None, &r.status, changed)),
            },
            Err(ApiError::Status { status: 404, .. }) => return Ok(restart(rec, changed)),
            Err(e) => return Err(e.into()),
        }
    }

    if rec.server_recording_id.is_none() {
        if size > contract::MAX_SIZE_BYTES {
            return Err(Stop::Api(ApiError::Status { status: 413, code: "too_large".into() }));
        }
        let body = CreateRecordingRequest {
            meeting: NewMeeting { title: meeting_title(&rec.title, rec.started_at), started_at: rec.started_at.to_rfc3339() },
            duration_s: rec.duration_s,
            sha256: sha256.clone(),
            size_bytes: size,
            source: contract::SOURCE_DESKTOP.into(),
            content_type: contract::CONTENT_TYPE_OGG_OPUS.into(),
        };
        let created = api.create(token, &body).await?;
        rec.apply(
            Event::Created {
                recording_id: created.id,
                meeting_id: created.meeting_id,
                chunk_size_bytes: created.chunk_size_bytes,
                chunk_count: created.chunk_count,
                upload_url: created.upload_url,
            },
            Utc::now(),
        );
        // The server id must be on the disk before the first chunk, or a
        // restart would create a second recording on the server.
        changed(rec).map_err(|_| Stop::NotSaved)?;
    }

    let id = rec.server_recording_id.clone().expect("created above");
    let chunk_size = rec.chunk_size_bytes.unwrap_or(chunks::CHUNK_SIZE);
    let count = rec.chunk_count.unwrap_or_else(|| chunks::chunk_count(size, chunk_size));
    let upload_url = rec.upload_url.clone().unwrap_or_else(|| format!("/api/v1/recordings/{id}/chunks"));

    for _round in 0..MAX_COMPLETE_ROUNDS {
        for n in chunks::missing(count, &rec.chunks_received) {
            let path = file.to_path_buf();
            let bytes = tokio::task::spawn_blocking(move || chunks::read_chunk(&path, n, size, chunk_size))
                .await
                .map_err(|e| Stop::File(format!("read: {e}")))?
                .map_err(|_| Stop::File("file_missing".into()))?;
            let url = api.chunk_url(&upload_url, n)?;
            let mut busy = 0;
            loop {
                match api.put_chunk(token, url.clone(), bytes.clone()).await {
                    Ok(receipt) => {
                        let mut list = receipt.chunks_received;
                        if !list.contains(&n) {
                            list.push(n);
                        }
                        rec.apply(Event::ChunksReceived(list), Utc::now());
                        changed(rec).map_err(|_| Stop::NotSaved)?;
                        break;
                    }
                    Err(ApiError::Conflict(c)) if c.reason == "busy" && busy < MAX_BUSY_WAITS => {
                        busy += 1;
                        let wait = c.retry_after.unwrap_or(1).clamp(1, 30);
                        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                    }
                    Err(ApiError::Conflict(c)) if c.reason == "not_uploading" => {
                        return after_session_gone(rec, api, token, &id, changed).await;
                    }
                    Err(ApiError::Status { status: 404, .. }) => return Ok(restart(rec, changed)),
                    Err(e) => return Err(e.into()),
                }
            }
        }

        let body = CompleteRecordingRequest { sha256: sha256.clone(), size_bytes: size, duration_s: rec.duration_s };
        match api.complete(token, &id, &body).await {
            Ok(r) => return Ok(confirmed(rec, r.confirmed_at.as_deref(), &r.status, changed)),
            Err(ApiError::Conflict(c)) if c.reason == "missing_chunks" => {
                let missing = c.missing.unwrap_or_default();
                let held: Vec<u64> = (1..=count).filter(|n| !missing.contains(n)).collect();
                rec.apply(Event::ChunksReceived(held), Utc::now());
                changed(rec).map_err(|_| Stop::NotSaved)?;
            }
            Err(ApiError::Conflict(c)) if c.reason == "not_uploading" => {
                return after_session_gone(rec, api, token, &id, changed).await;
            }
            Err(ApiError::Status { status: 422, .. }) | Err(ApiError::Status { status: 404, .. }) => {
                return Ok(restart(rec, changed));
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(Stop::Api(ApiError::Status { status: 500, code: "missing_chunks".into() }))
}

/// The session no longer takes chunks: confirmed already, or gone.
async fn after_session_gone(
    rec: &mut RecordingState,
    api: &Api,
    token: &str,
    id: &str,
    changed: &mut Persist<'_>,
) -> Result<Outcome, Stop> {
    match api.get(token, id).await {
        Ok(r) if r.confirmed_at.is_some() || matches!(r.status.as_str(), "confirmed" | "transcribing" | "transcribed") => {
            Ok(confirmed(rec, r.confirmed_at.as_deref(), &r.status, changed))
        }
        Ok(_) | Err(ApiError::Status { status: 404, .. }) => Ok(restart(rec, changed)),
        Err(e) => Err(e.into()),
    }
}

fn confirmed(
    rec: &mut RecordingState,
    at: Option<&str>,
    server_status: &str,
    changed: &mut Persist<'_>,
) -> Outcome {
    let now = Utc::now();
    let at = at.and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&Utc)).unwrap_or(now);
    rec.apply(Event::Confirmed { at }, now);
    rec.apply(Event::ServerStatus(server_status.to_string()), now);
    if changed(rec).is_err() {
        return Outcome::NotSaved;
    }
    Outcome::Confirmed
}

fn restart(rec: &mut RecordingState, changed: &mut Persist<'_>) -> Outcome {
    rec.apply(Event::Restart, Utc::now());
    if changed(rec).is_err() {
        return Outcome::NotSaved;
    }
    if rec.due(Utc::now()) {
        Outcome::Restarted
    } else {
        Outcome::Failed
    }
}

/// After the confirm: the server's status, until it is final.
pub async fn refresh_server_status(
    rec: &mut RecordingState,
    api: &Api,
    token: &str,
) -> Result<bool, ApiError> {
    let Some(id) = rec.server_recording_id.clone() else { return Ok(false) };
    let r = api.get(token, &id).await?;
    let changed = rec.server_status.as_deref() != Some(r.status.as_str());
    rec.apply(Event::ServerStatus(r.status), Utc::now());
    Ok(changed)
}

/// The title the server gets: trimmed, at most 500 characters. The window
/// always sends a title in the user's language; an empty one (a state file
/// edited by hand) becomes the start time, which needs no translation.
pub fn meeting_title(title: &str, started_at: DateTime<Utc>) -> String {
    let t: String = title.trim().chars().take(contract::MAX_TITLE_CHARS).collect();
    if t.trim().is_empty() {
        started_at.format("%Y-%m-%d %H:%M UTC").to_string()
    } else {
        t.trim_end().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_trimmed_and_capped() {
        let at = DateTime::parse_from_rfc3339("2026-10-23T09:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(meeting_title("  Plan  ", at), "Plan");
        assert_eq!(meeting_title("   ", at), "2026-10-23 09:00 UTC");
        let long = "æ".repeat(600);
        assert_eq!(meeting_title(&long, at).chars().count(), 500);
    }

    #[test]
    fn failures_are_classified() {
        let c = |e| classify(&Stop::Api(e));
        assert_eq!(c(ApiError::Network("x".into())), (PendingReason::Network, true));
        assert_eq!(c(ApiError::Unauthorized), (PendingReason::SignedOut, false));
        assert_eq!(c(ApiError::Status { status: 502, code: "internal".into() }), (PendingReason::Server, true));
        assert_eq!(
            c(ApiError::Status { status: 403, code: "source_disabled".into() }),
            (PendingReason::Rejected { code: "source_disabled".into() }, false)
        );
        assert_eq!(
            classify(&Stop::File("file_missing".into())),
            (PendingReason::Rejected { code: "file_missing".into() }, false)
        );
    }
}
