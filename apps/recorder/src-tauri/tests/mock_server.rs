//! The uploader and the token poll against a mock of the install, built from
//! the contract: `POST /recorder/token`, `DELETE /recorder/tokens/{id}`,
//! `POST /recordings`, `PUT .../chunks/{n}`, `POST .../complete`,
//! `GET /recordings/{id}`. Faults are switched on per test.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use mtxt_recorder::api::{Api, PollResult};
use mtxt_recorder::connect::Pkce;
use mtxt_recorder::queue::state::{Event, Owner, PendingReason, RecordingState, Status};
use mtxt_recorder::queue::select::{next_upload, status_targets, Connection};
use mtxt_recorder::queue::uploader::{attempt, refresh_server_status, Outcome};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::sync::{Arc, Mutex};

const TOKEN: &str = "mtxt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHUNK: u64 = 1_000_000;

#[derive(Default)]
struct Rec {
    meeting_id: String,
    sha256: String,
    size: u64,
    chunks: BTreeMap<u64, Vec<u8>>,
    status: String,
    confirmed_at: Option<String>,
}

#[derive(Default)]
struct Mock {
    recordings: HashMap<String, Rec>,
    next_id: u32,
    puts: HashMap<u64, u32>,
    creates: u32,
    /// Chunk numbers that answer 409 busy once.
    busy_once: Vec<u64>,
    /// Chunk numbers that answer 500 once.
    fail_once: Vec<u64>,
    /// complete answers 422 hash_mismatch this many times.
    hash_mismatch: u32,
    /// complete forgets these chunks once and answers missing_chunks.
    forget_on_complete: Vec<u64>,
    /// Every bearer call answers 401.
    revoked: bool,
    /// Polls that answer 202 before the token comes.
    pending_polls: u32,
    polls: u32,
    deleted_tokens: Vec<String>,
    /// Every request this install received.
    requests: u32,
    /// Bearer tokens this install accepts besides TOKEN, and every one it saw.
    extra_tokens: Vec<String>,
    tokens_seen: Vec<String>,
}

type S = Arc<Mutex<Mock>>;

fn authed(h: &HeaderMap, m: &mut Mock) -> bool {
    let bearer = h.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::to_string);
    if let Some(t) = &bearer {
        m.tokens_seen.push(t.clone());
    }
    !m.revoked && bearer.is_some_and(|t| t == TOKEN || m.extra_tokens.contains(&t))
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": { "code": code, "message": code } }))).into_response()
}

fn recording_json(id: &str, r: &Rec) -> Value {
    json!({
        "id": id, "meeting_id": r.meeting_id, "status": r.status, "sha256": r.sha256, "size_bytes": r.size,
        "duration_s": 60, "source": "desktop", "created_at": "2026-10-23T09:00:00Z",
        "chunk_count": r.size.div_ceil(CHUNK),
        "chunks_received": if r.status == "uploading" { r.chunks.keys().copied().collect::<Vec<_>>() } else { vec![] },
        "confirmed_at": r.confirmed_at, "error": null
    })
}

async fn create(State(s): State<S>, h: HeaderMap, Json(body): Json<Value>) -> Response {
    let mut m = s.lock().unwrap();
    m.requests += 1;
    if !authed(&h, &mut m) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    assert_eq!(body["source"], "desktop");
    assert_eq!(body["content_type"], "audio/ogg; codecs=opus");
    assert!(body["meeting"]["title"].as_str().is_some_and(|t| !t.is_empty()));
    m.next_id += 1;
    m.creates += 1;
    let id = format!("rec{}", m.next_id);
    let size = body["size_bytes"].as_u64().unwrap();
    m.recordings.insert(
        id.clone(),
        Rec { meeting_id: "m1".into(), sha256: body["sha256"].as_str().unwrap().into(), size, status: "uploading".into(), ..Default::default() },
    );
    (
        StatusCode::CREATED,
        Json(json!({ "id": id, "meeting_id": "m1", "upload_url": format!("/api/v1/recordings/{id}/chunks"),
                     "chunk_size_bytes": CHUNK, "chunk_count": size.div_ceil(CHUNK), "status": "uploading" })),
    )
        .into_response()
}

async fn chunk(State(s): State<S>, h: HeaderMap, Path((id, n)): Path<(String, u64)>, body: Bytes) -> Response {
    let mut m = s.lock().unwrap();
    m.requests += 1;
    if !authed(&h, &mut m) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    assert_eq!(h.get("content-type").unwrap(), "application/octet-stream");
    if let Some(i) = m.busy_once.iter().position(|x| *x == n) {
        m.busy_once.remove(i);
        return (StatusCode::CONFLICT, [("retry-after", "1")], Json(json!({ "error": { "code": "busy", "message": "busy" }, "reason": "busy" })))
            .into_response();
    }
    if let Some(i) = m.fail_once.iter().position(|x| *x == n) {
        m.fail_once.remove(i);
        return error(StatusCode::INTERNAL_SERVER_ERROR, "internal");
    }
    *m.puts.entry(n).or_default() += 1;
    let Some(r) = m.recordings.get_mut(&id) else { return error(StatusCode::NOT_FOUND, "not_found") };
    if r.status != "uploading" {
        return (StatusCode::CONFLICT, Json(json!({ "error": { "code": "not_uploading", "message": "x" }, "reason": "not_uploading" }))).into_response();
    }
    assert!(body.len() as u64 <= CHUNK);
    r.chunks.insert(n, body.to_vec());
    let received: Vec<u64> = r.chunks.keys().copied().collect();
    Json(json!({ "n": n, "size_bytes": body.len(), "chunks_received": received, "chunk_count": r.size.div_ceil(CHUNK) })).into_response()
}

async fn complete(State(s): State<S>, h: HeaderMap, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let mut m = s.lock().unwrap();
    m.requests += 1;
    if !authed(&h, &mut m) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let forget = std::mem::take(&mut m.forget_on_complete);
    let mismatch = m.hash_mismatch > 0;
    if mismatch {
        m.hash_mismatch -= 1;
    }
    let Some(r) = m.recordings.get_mut(&id) else { return error(StatusCode::NOT_FOUND, "not_found") };
    if r.status != "uploading" {
        return Json(recording_json(&id, r)).into_response();
    }
    for n in &forget {
        r.chunks.remove(n);
    }
    let count = r.size.div_ceil(CHUNK);
    let missing: Vec<u64> = (1..=count).filter(|n| !r.chunks.contains_key(n)).collect();
    if !missing.is_empty() {
        return (StatusCode::CONFLICT, Json(json!({ "error": { "code": "missing_chunks", "message": "x" }, "reason": "missing_chunks", "missing": missing })))
            .into_response();
    }
    let whole: Vec<u8> = r.chunks.values().flatten().copied().collect();
    let hash = hex::encode(Sha256::digest(&whole));
    assert_eq!(body["sha256"].as_str().unwrap(), r.sha256);
    if mismatch || hash != r.sha256 || whole.len() as u64 != r.size {
        r.status = "failed".into();
        return error(StatusCode::UNPROCESSABLE_ENTITY, "hash_mismatch");
    }
    r.status = "confirmed".into();
    r.confirmed_at = Some("2026-10-23T10:00:00Z".into());
    Json(recording_json(&id, r)).into_response()
}

async fn get_rec(State(s): State<S>, h: HeaderMap, Path(id): Path<String>) -> Response {
    let mut m = s.lock().unwrap();
    m.requests += 1;
    if !authed(&h, &mut m) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    match m.recordings.get(&id) {
        Some(r) => Json(recording_json(&id, r)).into_response(),
        None => error(StatusCode::NOT_FOUND, "not_found"),
    }
}

async fn token(State(s): State<S>, Json(body): Json<Value>) -> Response {
    let mut m = s.lock().unwrap();
    m.requests += 1;
    let challenge = body["challenge"].as_str().unwrap_or("");
    let verifier = body["verifier"].as_str().unwrap_or("");
    if mtxt_recorder::connect::challenge_for(verifier) != challenge {
        return error(StatusCode::GONE, "denied");
    }
    m.polls += 1;
    if m.polls <= m.pending_polls {
        return (StatusCode::ACCEPTED, [("retry-after", "1")], Json(json!({ "status": "pending" }))).into_response();
    }
    if m.polls > m.pending_polls + 1 {
        return error(StatusCode::GONE, "expired");
    }
    Json(json!({
        "token": TOKEN, "token_id": "tok1", "expires_at": "2027-04-21T09:00:00Z", "device_name": "Mettes Mac",
        "user": { "id": "u1", "name": "Mette Lund", "email": "mette.lund@example.com" },
        "install": { "product_name": "Primux Møder", "theme_accent": "#566b45", "theme_primary": "#111111",
                     "interface_language": "da", "live_transcript_default": true }
    }))
    .into_response()
}

async fn revoke(State(s): State<S>, h: HeaderMap, Path(id): Path<String>) -> Response {
    let mut m = s.lock().unwrap();
    m.requests += 1;
    if !authed(&h, &mut m) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if id != "tok1" {
        return error(StatusCode::NOT_FOUND, "not_found");
    }
    m.deleted_tokens.push(id);
    StatusCode::NO_CONTENT.into_response()
}

async fn serve(mock: Mock) -> (String, S) {
    let state: S = Arc::new(Mutex::new(mock));
    let app = Router::new()
        .route("/api/v1/recorder/token", post(token))
        .route("/api/v1/recorder/tokens/{id}", delete(revoke))
        .route("/api/v1/recordings", post(create))
        .route("/api/v1/recordings/{id}", get(get_rec))
        .route("/api/v1/recordings/{id}/chunks/{n}", put(chunk))
        .route("/api/v1/recordings/{id}/complete", post(complete))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, state)
}

/// A 2.5 MB file (three chunks of 1 MB on this server) and its queue entry.
fn recording(origin: &str) -> (tempfile::TempDir, std::path::PathBuf, RecordingState) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("r.ogg");
    let data: Vec<u8> = (0..2_500_000u32).map(|i| (i * 7 % 251) as u8).collect();
    std::fs::File::create(&path).unwrap().write_all(&data).unwrap();
    let (sha256, size) = mtxt_recorder::queue::chunks::hash_file(&path).unwrap();
    let mut rec = RecordingState::new("local1".into(), origin.into(), "Produktionsmøde".into(), chrono::Utc::now());
    rec.owner = Some(Owner { user_id: "u1".into(), email: "mette.lund@example.com".into() });
    rec.apply(Event::Stopped { at: chrono::Utc::now(), duration_s: 60, sha256, size_bytes: size }, chrono::Utc::now());
    (dir, path, rec)
}

async fn run(rec: &mut RecordingState, origin: &str, path: &std::path::Path) -> (Outcome, Vec<RecordingState>) {
    let api = Api::new(origin).unwrap();
    let mut seen = Vec::new();
    let out = attempt(rec, &api, TOKEN, path, &mut |r: &RecordingState| {
        seen.push(r.clone());
        Ok(())
    })
    .await;
    (out, seen)
}

#[tokio::test]
async fn uploads_in_chunks_waits_on_busy_and_confirms() {
    let (origin, state) = serve(Mock { busy_once: vec![2], ..Default::default() }).await;
    let (_dir, path, mut rec) = recording(&origin);
    let (out, seen) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Confirmed);
    assert_eq!(rec.status, Status::Confirmed);
    assert_eq!(rec.confirmed_at.unwrap().to_rfc3339(), "2026-10-23T10:00:00+00:00");
    assert_eq!(rec.progress(), (3, 3));
    // Progress was written after every chunk: 1/3, 2/3, 3/3.
    let progress: Vec<u64> = seen.iter().map(|r| r.progress().0).collect();
    assert!(progress.windows(2).all(|w| w[0] <= w[1]));
    assert!(progress.contains(&1) && progress.contains(&2));
    let m = state.lock().unwrap();
    assert_eq!(m.puts.values().sum::<u32>(), 3);
    assert_eq!(m.recordings["rec1"].status, "confirmed");
}

#[tokio::test]
async fn a_failed_chunk_resumes_from_what_the_server_holds() {
    let (origin, state) = serve(Mock { fail_once: vec![2], ..Default::default() }).await;
    let (_dir, path, mut rec) = recording(&origin);
    let (out, _) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Failed);
    assert_eq!(rec.status, Status::Pending);
    assert_eq!(rec.pending_reason, Some(PendingReason::Server));
    assert_eq!(rec.chunks_received, vec![1]);
    assert!(rec.next_attempt_at.is_some());

    // The state survives a restart of the app: write and read it back.
    let json = serde_json::to_string(&rec).unwrap();
    let mut rec: RecordingState = serde_json::from_str(&json).unwrap();
    let (out, _) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Confirmed);
    let m = state.lock().unwrap();
    assert_eq!(m.creates, 1, "the second attempt resumed the same recording");
    assert_eq!(m.puts[&1], 1, "chunk 1 was not sent again");
    assert_eq!(m.puts[&2], 1);
    assert_eq!(m.puts[&3], 1);
}

#[tokio::test]
async fn missing_chunks_at_complete_are_sent_again() {
    let (origin, state) = serve(Mock { forget_on_complete: vec![2], ..Default::default() }).await;
    let (_dir, path, mut rec) = recording(&origin);
    let (out, _) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Confirmed);
    assert_eq!(state.lock().unwrap().puts[&2], 2);
}

#[tokio::test]
async fn a_hash_mismatch_starts_again_with_a_new_recording() {
    let (origin, state) = serve(Mock { hash_mismatch: 1, ..Default::default() }).await;
    let (_dir, path, mut rec) = recording(&origin);
    let (out, _) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Restarted);
    assert_eq!(rec.server_recording_id, None);
    assert_eq!(rec.restarts, 1);
    assert!(rec.due(chrono::Utc::now()));
    let (out, _) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Confirmed);
    assert_eq!(rec.server_recording_id.as_deref(), Some("rec2"));
    assert_eq!(state.lock().unwrap().creates, 2);
}

#[tokio::test]
async fn a_revoked_token_waits_for_a_new_connection() {
    let (origin, _state) = serve(Mock { revoked: true, ..Default::default() }).await;
    let (_dir, path, mut rec) = recording(&origin);
    let (out, _) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Failed);
    assert_eq!(rec.pending_reason, Some(PendingReason::SignedOut));
    assert!(!rec.due(chrono::Utc::now() + chrono::Duration::days(1)));
    assert!(rec.is_unconfirmed(), "the file stays in the queue");
}

#[tokio::test]
async fn no_network_is_pending_with_a_retry_time() {
    // Nothing listens on this port.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let (_dir, path, mut rec) = recording(&origin);
    let (out, _) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Failed);
    assert_eq!(rec.status, Status::Pending);
    assert_eq!(rec.pending_reason, Some(PendingReason::Network));
    let wait = rec.next_attempt_at.unwrap() - chrono::Utc::now();
    assert!(wait <= chrono::Duration::seconds(3), "the first retry comes after about 2 s");
}

#[tokio::test]
async fn a_missing_local_file_is_a_rejection_not_a_deletion() {
    let (origin, _state) = serve(Mock::default()).await;
    let (dir, path, mut rec) = recording(&origin);
    std::fs::remove_file(&path).unwrap();
    let (out, _) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Failed);
    assert_eq!(rec.pending_reason, Some(PendingReason::Rejected { code: "file_missing".into() }));
    drop(dir);
}

#[tokio::test]
async fn the_token_poll_waits_then_gets_the_token_once_and_disconnect_revokes_it() {
    let (origin, state) = serve(Mock { pending_polls: 2, ..Default::default() }).await;
    let api = Api::new(&origin).unwrap();
    let pkce = Pkce::generate();
    let mut pendings = 0;
    let token = loop {
        match api.poll_token(&pkce).await {
            PollResult::Pending { retry_after } => {
                assert_eq!(retry_after, 1);
                pendings += 1;
            }
            PollResult::Token(t) => break t,
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(pendings, 2);
    assert_eq!(token.install.interface_language.as_deref(), Some("da"));
    assert_eq!(token.install.live_transcript_default, Some(true));
    assert!(matches!(api.poll_token(&pkce).await, PollResult::Gone { code } if code == "expired"));
    // A verifier that does not match its challenge is denied.
    let wrong = Pkce { verifier: Pkce::generate().verifier, challenge: pkce.challenge.clone() };
    assert!(matches!(api.poll_token(&wrong).await, PollResult::Gone { code } if code == "denied"));
    api.revoke(&token.token, &token.token_id).await.unwrap();
    assert!(api.revoke(&token.token, "someone-else").await.is_err());
    assert_eq!(state.lock().unwrap().deleted_tokens, vec!["tok1"]);
}

/// What the app's uploader loop and status poll do, for a few rounds, with
/// one connection: choose through `select`, send only to the connection's host.
async fn run_queue(queue: &mut [RecordingState], host: &str, user: &Owner, files: &std::collections::HashMap<String, std::path::PathBuf>) {
    let api = Api::new(host).unwrap();
    for _ in 0..10 {
        let c = Connection { host, user };
        let Some(id) = next_upload(queue, &c, chrono::Utc::now()).map(|r| r.id.clone()) else { break };
        let rec = queue.iter_mut().find(|r| r.id == id).unwrap();
        attempt(rec, &api, TOKEN, &files[&id], &mut |_: &RecordingState| Ok(())).await;
    }
    let since = chrono::Utc::now() - chrono::Duration::hours(24);
    let c = Connection { host, user };
    let ids: Vec<String> = status_targets(queue, &c, since).iter().map(|r| r.id.clone()).collect();
    for id in ids {
        let rec = queue.iter_mut().find(|r| r.id == id).unwrap();
        refresh_server_status(rec, &api, TOKEN).await.unwrap();
    }
}

fn queued(id: &str, host: &str, user: &Owner, dir: &std::path::Path) -> (RecordingState, std::path::PathBuf) {
    let path = dir.join(format!("{id}.ogg"));
    std::fs::write(&path, vec![3u8; 1_200_000]).unwrap();
    let (sha256, size) = mtxt_recorder::queue::chunks::hash_file(&path).unwrap();
    let mut rec = RecordingState::new(id.into(), host.into(), id.into(), chrono::Utc::now());
    rec.owner = Some(user.clone());
    rec.apply(Event::Stopped { at: chrono::Utc::now(), duration_s: 60, sha256, size_bytes: size }, chrono::Utc::now());
    (rec, path)
}

#[tokio::test]
async fn one_token_reaches_only_its_own_install() {
    let (a, a_state) = serve(Mock::default()).await;
    let (b, b_state) = serve(Mock::default()).await;
    let dir = tempfile::tempdir().unwrap();
    let me = Owner { user_id: "u1".into(), email: "mette.lund@example.com".into() };
    let (ra, pa) = queued("for-a", &a, &me, dir.path());
    let (mut rb, pb) = queued("for-b", &b, &me, dir.path());
    // B's recording was confirmed earlier: a status poll would contact B.
    rb.apply(Event::Confirmed { at: chrono::Utc::now() }, chrono::Utc::now());
    rb.server_recording_id = Some("rec1".into());
    let files = [("for-a".to_string(), pa), ("for-b".to_string(), pb)].into_iter().collect();
    let mut queue = vec![ra, rb];
    run_queue(&mut queue, &a, &me, &files).await;
    assert_eq!(queue[0].status, Status::Confirmed);
    assert!(a_state.lock().unwrap().requests > 0);
    assert_eq!(b_state.lock().unwrap().requests, 0, "install B received a request with A's token");
    assert_eq!(queue[1].server_status, None);
}

#[tokio::test]
async fn one_users_token_never_uploads_another_users_recording() {
    let (a, a_state) = serve(Mock::default()).await;
    let dir = tempfile::tempdir().unwrap();
    let mette = Owner { user_id: "u1".into(), email: "mette.lund@example.com".into() };
    let anne = Owner { user_id: "u2".into(), email: "anne.holm@example.com".into() };
    let (rm, pm) = queued("mettes", &a, &mette, dir.path());
    let (ra, pa) = queued("annes", &a, &anne, dir.path());
    let files = [("mettes".to_string(), pm), ("annes".to_string(), pa)].into_iter().collect();
    let mut queue = vec![rm, ra];
    // Anne is connected now; Mette's recording must stay on the Mac.
    run_queue(&mut queue, &a, &anne, &files).await;
    assert_eq!(queue[1].status, Status::Confirmed);
    assert_eq!(queue[0].status, Status::Uploading, "Mette's recording was touched");
    assert_eq!(queue[0].server_recording_id, None);
    assert_eq!(a_state.lock().unwrap().creates, 1);
}

#[tokio::test]
async fn a_confirmed_recording_whose_transcription_failed_is_not_sent_again() {
    let (origin, state) = serve(Mock::default()).await;
    let (_dir, path, mut rec) = recording(&origin);
    assert_eq!(run(&mut rec, &origin, &path).await.0, Outcome::Confirmed);
    // The confirm reply was lost, and the server's transcription failed.
    {
        let mut m = state.lock().unwrap();
        m.recordings.get_mut("rec1").unwrap().status = "failed".into();
    }
    rec.status = Status::Uploading;
    rec.confirmed_at = None;
    let (out, _) = run(&mut rec, &origin, &path).await;
    assert_eq!(out, Outcome::Confirmed);
    assert_eq!(rec.server_status.as_deref(), Some("failed"));
    assert_eq!(state.lock().unwrap().creates, 1, "a second meeting was created");
}

#[tokio::test]
async fn no_state_write_no_request() {
    let (origin, state) = serve(Mock::default()).await;
    let (_dir, path, mut rec) = recording(&origin);
    let api = Api::new(&origin).unwrap();
    for _ in 0..2 {
        let out = attempt(&mut rec, &api, TOKEN, &path, &mut |_: &RecordingState| Err("No space left on device (os error 28)".to_string())).await;
        assert_eq!(out, Outcome::NotSaved);
    }
    let m = state.lock().unwrap();
    assert_eq!(m.creates, 0, "a recording was created on the server");
    assert_eq!(m.requests, 0);
}

#[tokio::test]
async fn a_server_id_that_cannot_be_written_stops_before_the_first_chunk() {
    let (origin, state) = serve(Mock::default()).await;
    let (_dir, path, mut rec) = recording(&origin);
    let api = Api::new(&origin).unwrap();
    let out = attempt(&mut rec, &api, TOKEN, &path, &mut |r: &RecordingState| {
        if r.server_recording_id.is_some() { Err("disk full".into()) } else { Ok(()) }
    })
    .await;
    assert_eq!(out, Outcome::NotSaved);
    let m = state.lock().unwrap();
    assert_eq!(m.creates, 1);
    assert_eq!(m.puts.values().sum::<u32>(), 0, "a chunk went out before the server id was saved");
}

/// The reviewer's sequence: connected as A; reconnecting as B fails to write
/// the profile; the app restarts. A's recording must never go out with B's
/// token, and B's token must not be stored at all.
#[tokio::test]
async fn a_failed_reconnect_never_uploads_with_the_new_users_token() {
    use mtxt_recorder::contract::{RecorderInstall, RecorderToken, RecorderUser};
    use mtxt_recorder::credentials::{bind, restore, SecretStore};
    use mtxt_recorder::profile::Profile;

    #[derive(Default)]
    struct Memory(std::sync::Mutex<HashMap<String, String>>);
    impl SecretStore for Memory {
        fn set(&self, h: &str, v: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(h.into(), v.into());
            Ok(())
        }
        fn get(&self, h: &str) -> Option<String> {
            self.0.lock().unwrap().get(h).cloned()
        }
        fn delete(&self, h: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(h);
            Ok(())
        }
    }
    let token_b = "mtxt_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    let (origin, state) = serve(Mock { extra_tokens: vec![token_b.into()], ..Default::default() }).await;
    let issued = |token: &str, id: &str, user: &str| RecorderToken {
        token: token.into(),
        token_id: id.into(),
        expires_at: "2027-04-21T00:00:00Z".into(),
        device_name: "Mac".into(),
        user: RecorderUser { id: user.into(), name: user.into(), email: format!("{user}@example.com") },
        install: RecorderInstall { product_name: "P".into(), theme_accent: "#566b45".into(), theme_primary: "#111111".into(), interface_language: None, live_transcript_default: None },
    };
    let data = tempfile::tempdir().unwrap();
    let keychain = Memory::default();
    let mut profile = Profile::load(data.path());
    let ok = |p: &Profile| p.save(data.path());
    bind(&mut profile, &ok, &keychain, &origin, &issued(TOKEN, "tok-a", "u1")).unwrap();
    // A's recording waits in the queue.
    let (_dir, path, mut rec) = recording(&origin);
    // Reconnect as B: the profile write fails.
    let fail = |_: &Profile| Err(std::io::Error::from_raw_os_error(28));
    assert!(bind(&mut profile, &fail, &keychain, &origin, &issued(token_b, "tok-b", "u2")).is_err());
    // Restart: what is on the disk and in the Keychain.
    let profile = Profile::load(data.path());
    let credential = restore(&profile, &keychain).expect("A's binding and A's token");
    let me = profile.owner().unwrap();
    assert_eq!(me.user_id, "u1");
    let c = Connection { host: &origin, user: &me };
    let queue = [rec.clone()];
    if next_upload(&queue, &c, chrono::Utc::now()).is_some() {
        let api = Api::new(&origin).unwrap();
        attempt(&mut rec, &api, &credential.token, &path, &mut |_: &RecordingState| Ok(())).await;
    }
    let m = state.lock().unwrap();
    assert!(!m.tokens_seen.iter().any(|t| t == token_b), "B's token reached the install");
    assert!(m.tokens_seen.iter().all(|t| t == TOKEN));
    assert!(!keychain.0.lock().unwrap().values().any(|v| v.contains(token_b)), "B's token was stored");
}
