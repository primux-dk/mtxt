//! The recorder's state and what changes it: connecting, recording, the
//! upload queue, the live transcript. The windows read it as one snapshot,
//! sent after every change; they never hold state of their own beyond what
//! is on screen.

use crate::api::{Api, ApiError, PollResult};
use crate::audio::recorder::{self, LiveFeed, Recording, Wanted};
use crate::connect::{self, Pkce};
use crate::live::{models, LiveSession, LiveTranscript, LiveUpdate};
use crate::permissions::{self, Permission, Permissions};
use crate::profile::Profile;
use crate::queue::recovery::{inspect_file, FileCheck};
use crate::queue::select::{self as select, Connection as Conn};
use crate::queue::state::Owner;
use crate::queue::store::{Damaged, ExportError, Store};
use crate::queue::{uploader, Event, OnFail, PendingReason, Queue, RecordingState, Status};
use crate::credentials::{self, Credential, Keychain, SecretStore};
use crate::locale;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

pub struct App {
    pub handle: AppHandle,
    pub data_dir: PathBuf,
    pub models_dir: PathBuf,
    pub store: Store,
    inner: Mutex<Inner>,
    pub wake: Notify,
    pub live_feed: Arc<LiveFeed>,
}

pub struct Inner {
    pub profile: Profile,
    /// The token, only while it matches the profile's binding (`credentials.rs`).
    pub credential: Option<Credential>,
    pub queue: Queue,
    pub active: Option<Active>,
    pub connect: Option<ConnectAttempt>,
    pub connect_error: Option<Notice>,
    pub online: bool,
    pub downloads: HashMap<String, Download>,
    pub live: Option<LiveSession>,
    /// The running recording's live transcript, in memory only.
    pub live_text: LiveTranscript,
    /// Live sessions started so far; the next one gets the next number.
    pub live_sessions: u64,
    pub live_hidden: bool,
    /// The recording whose 7-day question is open.
    pub ask: Option<String>,
    pub notice: Option<Notice>,
    pub uploading: Option<String>,
    /// State files that do not parse, with or without their audio.
    pub damaged: Vec<Damaged>,
}

pub struct Active {
    pub id: String,
    pub recording: Option<Recording>,
    pub started: Instant,
    pub started_at: DateTime<Utc>,
    pub title: String,
    pub sources: Sources,
    pub stopping: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sources {
    /// `on`, `lost` (the device went away), `off` (not allowed or failed) or `starting`.
    pub microphone: &'static str,
    pub system_audio: &'static str,
}

pub struct ConnectAttempt {
    pub pkce: Pkce,
    pub pairing_code: String,
    pub url: String,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Notice {
    pub key: String,
    pub args: HashMap<String, serde_json::Value>,
}

impl Notice {
    pub fn new(key: &str) -> Notice {
        Notice { key: key.into(), args: HashMap::new() }
    }
    pub fn arg(mut self, k: &str, v: impl Into<serde_json::Value>) -> Notice {
        self.args.insert(k.into(), v.into());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Download {
    pub done: u64,
    pub total: u64,
    pub failed: bool,
}

// ---------- the snapshot the windows render ----------

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    /// `setup`, `connecting` or `ready`.
    pub phase: &'static str,
    pub host: Option<String>,
    pub host_label: Option<String>,
    pub pairing_code: Option<String>,
    pub connect_error: Option<Notice>,
    pub connection: Option<ConnectionView>,
    pub signed_out: bool,
    pub language: &'static str,
    /// `macos` or `windows`: which wording of the locale files the window uses.
    pub platform: &'static str,
    pub permissions: Permissions,
    pub permissions_asked: bool,
    pub recording: Option<RecordingView>,
    pub queue: Vec<QueueItem>,
    pub online: bool,
    pub live: LiveView,
    pub ask: Option<QueueItem>,
    pub notice: Option<Notice>,
    pub damaged: Vec<DamagedView>,
    pub version: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct DamagedView {
    pub id: String,
    pub error: String,
    pub has_audio: bool,
}

pub use crate::queue::select::Blocked;

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionView {
    pub product_name: String,
    pub theme_accent: String,
    pub theme_primary: String,
    pub user_name: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingView {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub elapsed_s: u64,
    pub sources: Sources,
    pub stopping: bool,
    pub starting: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueueItem {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub duration_s: u64,
    pub size_bytes: Option<u64>,
    pub status: Status,
    pub reason: Option<PendingReason>,
    pub done: u64,
    pub total: u64,
    pub server_status: Option<String>,
    pub meeting_url: Option<String>,
    pub active: bool,
    pub blocked: Option<Blocked>,
    pub local_error: Option<String>,
    pub can_save: bool,
    /// The audio is on this Mac.
    pub has_file: bool,
    pub recovered: bool,
    /// Finished by recovery; uploads after the user says so.
    pub needs_review: bool,
    /// The latest change is not on the disk yet: the error.
    pub unsaved: Option<String>,
    pub gaps: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveView {
    pub enabled: bool,
    pub model: String,
    pub models: Vec<ModelView>,
    pub hidden: bool,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelView {
    pub id: &'static str,
    pub label: &'static str,
    pub size: u64,
    pub downloaded: bool,
    pub download: Option<Download>,
}

/// The newest recordings the list shows; older ones are summed in a line.
pub const QUEUE_SHOWN: usize = 50;

impl App {
    pub fn new(handle: AppHandle, data_dir: PathBuf) -> std::io::Result<Arc<App>> {
        std::fs::create_dir_all(&data_dir)?;
        let store = Store::new(&data_dir)?;
        let models_dir = data_dir.join("models");
        let profile = Profile::load(&data_dir);
        let credential = credentials::restore(&profile, &Keychain);
        let loaded = store.load_all();
        let app = Arc::new(App {
            handle,
            data_dir,
            models_dir,
            store,
            inner: Mutex::new(Inner {
                profile,
                credential,
                queue: Queue::new(loaded.recordings),
                active: None,
                connect: None,
                connect_error: None,
                online: true,
                downloads: HashMap::new(),
                live: None,
                live_text: LiveTranscript::default(),
                live_sessions: 0,
                live_hidden: false,
                ask: None,
                notice: None,
                uploading: None,
                damaged: loaded.damaged,
            }),
            wake: Notify::new(),
            live_feed: Arc::new(LiveFeed::default()),
        });
        // Deletions a crash interrupted finish first; their audio is not an orphan.
        {
            let mut inner = app.lock();
            inner.queue.finish_discards(&app.store, &app.store, Utc::now());
        }
        app.recover_interrupted();
        app.adopt_orphans(loaded.orphans);
        Ok(app)
    }

    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A recording left in `Recording` by a crash or a forced quit. The file
    /// plays up to its last flushed second, so it is finished and queued. Only
    /// a file positively established as empty is forgotten; any error while
    /// reading it keeps both files and marks the entry Unreadable.
    fn recover_interrupted(&self) {
        let ids: Vec<String> =
            self.lock().queue.items.iter().filter(|r| r.status == Status::Recording).map(|r| r.id.clone()).collect();
        for id in ids {
            self.recover(&id);
        }
    }

    /// Read a recording file back: Stopped, Unreadable, or forgotten when empty.
    pub fn recover(&self, id: &str) {
        let path = self.store.audio_path(id);
        match inspect_file(&path) {
            FileCheck::Empty => {
                log::info!("{id}: the file holds no audio; forgotten");
                if self.store.forget(id).is_ok() {
                    self.lock().queue.items.retain(|r| r.id != id);
                }
            }
            FileCheck::Readable { at, duration_s, sha256, size_bytes } => {
                log::info!("{id}: recovered, {duration_s} s; held for the user");
                // How the recording ended is unknown: it uploads after the user says so.
                let _ = self.apply(id, Event::Recovered { at, duration_s, sha256, size_bytes });
            }
            FileCheck::Error(error) => {
                log::warn!("{id}: unreadable: {error}");
                let _ = self.apply(id, Event::Unreadable { error });
            }
        }
    }

    /// Audio without a state file: listed as a recovered recording with the
    /// file's date, uploaded only when the user chooses to upload it.
    fn adopt_orphans(&self, orphans: Vec<crate::queue::store::Orphan>) {
        if orphans.is_empty() {
            return;
        }
        let strings = self.strings();
        let host = self.lock().profile.host.clone().unwrap_or_default();
        for o in orphans {
            let date = o.modified.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string();
            let title = strings.get("recorder.queue.recoveredTitle", &[("date", serde_json::json!(date))]);
            let mut rec = RecordingState::new(o.id.clone(), host.clone(), title, o.modified);
            rec.recovered = true;
            match inspect_file(&self.store.audio_path(&o.id)) {
                FileCheck::Empty => {
                    let _ = self.store.forget(&o.id);
                    continue;
                }
                FileCheck::Readable { at, duration_s, sha256, size_bytes } => {
                    rec.apply(Event::Stopped { at, duration_s, sha256, size_bytes }, Utc::now())
                }
                FileCheck::Error(error) => rec.apply(Event::Unreadable { error }, Utc::now()),
            }
            match self.store.save(&rec) {
                Ok(()) => self.lock().queue.items.push(rec),
                Err(e) => log::error!("could not list the recovered file {}: {e}", o.id),
            }
        }
        self.lock().queue.items.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    }

    pub fn language(inner: &Inner) -> &'static str {
        let system = sys_locale::get_locale();
        let install = inner.profile.connection.as_ref().and_then(|c| c.interface_language.clone());
        locale::choose(system.as_deref(), install.as_deref())
    }

    pub fn strings(&self) -> locale::Strings {
        locale::Strings::new(Self::language(&self.lock()))
    }

    pub fn snapshot(&self) -> Snapshot {
        let inner = self.lock();
        self.snapshot_of(&inner)
    }

    fn snapshot_of(&self, inner: &Inner) -> Snapshot {
        let p = &inner.profile;
        let phase = if inner.connect.is_some() {
            "connecting"
        } else if p.host.is_none() || p.connection.is_none() {
            "setup"
        } else {
            "ready"
        };
        let host_label = p.host.as_deref().map(|h| h.split("://").nth(1).unwrap_or(h).to_string());
        let queue: Vec<QueueItem> = inner.queue.items.iter().take(QUEUE_SHOWN).map(|r| self.item(inner, r)).collect();
        let ask = inner.ask.as_ref().and_then(|id| inner.queue.items.iter().find(|r| &r.id == id)).map(|r| self.item(inner, r));
        Snapshot {
            phase,
            host: p.host.clone(),
            host_label,
            pairing_code: inner.connect.as_ref().map(|c| c.pairing_code.clone()),
            connect_error: inner.connect_error.clone(),
            connection: p.connection.as_ref().map(|c| ConnectionView {
                product_name: c.product_name.clone(),
                theme_accent: c.theme_accent.clone(),
                theme_primary: c.theme_primary.clone(),
                user_name: c.user_name.clone(),
                device_name: c.device_name.clone(),
            }),
            signed_out: p.connection.is_some() && inner.credential.is_none(),
            language: Self::language(inner),
            platform: locale::PLATFORM,
            permissions: permissions::current(),
            permissions_asked: p.permissions_asked,
            recording: inner.active.as_ref().map(|a| RecordingView {
                id: a.id.clone(),
                title: a.title.clone(),
                started_at: a.started_at.to_rfc3339(),
                elapsed_s: a.started.elapsed().as_secs(),
                sources: a.sources.clone(),
                stopping: a.stopping,
                starting: a.recording.is_none() && !a.stopping,
            }),
            queue,
            online: inner.online,
            live: LiveView {
                enabled: p.live_enabled(),
                model: models::usable(&p.model).to_string(),
                models: models::available()
                    .iter()
                    .map(|s| ModelView {
                        id: s.id,
                        label: s.label,
                        size: s.total_size(),
                        downloaded: models::is_downloaded(&self.models_dir, s),
                        download: inner.downloads.get(s.id).cloned(),
                    })
                    .collect(),
                hidden: inner.live_hidden,
                running: inner.live.is_some(),
            },
            ask,
            notice: inner.notice.clone(),
            damaged: inner
                .damaged
                .iter()
                .map(|d| DamagedView { id: d.id.clone(), error: d.error.clone(), has_audio: d.has_audio })
                .collect(),
            version: env!("CARGO_PKG_VERSION"),
        }
    }

    fn item(&self, inner: &Inner, r: &RecordingState) -> QueueItem {
        let (done, total) = r.progress();
        let meeting_url = match (&r.server_meeting_id, r.status) {
            (Some(m), Status::Confirmed | Status::Deleted) => Some(format!("{}/meetings/{m}", r.host)),
            _ => None,
        };
        let reason = match &r.pending_reason {
            Some(PendingReason::Rejected { code }) if code == "file_missing" || code == "file_changed" => {
                Some(PendingReason::Rejected { code: "file_missing".into() })
            }
            other => other.clone(),
        };
        QueueItem {
            id: r.id.clone(),
            title: r.title.clone(),
            started_at: r.started_at.to_rfc3339(),
            duration_s: r.duration_s,
            size_bytes: r.size_bytes,
            status: r.status,
            reason,
            done,
            total,
            server_status: r.server_status.clone(),
            meeting_url,
            active: inner.uploading.as_deref() == Some(&r.id),
            blocked: {
                let me = inner.profile.owner();
                let host = inner.profile.host.clone().unwrap_or_default();
                let conn = me.as_ref().map(|user| Conn { host: &host, user });
                select::blocked(r, conn.as_ref())
            },
            local_error: r.local_error.clone(),
            can_save: r.can_save_elsewhere() && self.store.audio_path(&r.id).exists(),
            has_file: self.store.audio_path(&r.id).exists(),
            recovered: r.recovered,
            needs_review: r.needs_review,
            unsaved: inner.queue.unsaved_error(&r.id).map(str::to_string),
            gaps: r.gaps.len(),
        }
    }

    /// Send the snapshot to both windows and refresh the menu bar item.
    pub fn changed(&self) {
        let snap = self.snapshot();
        let _ = self.handle.emit("snapshot", &snap);
        crate::tray::refresh(&self.handle, &snap, &self.strings());
    }

    pub fn set_notice(&self, notice: Option<Notice>) {
        self.lock().notice = notice;
        self.changed();
    }

    // ---------- the queue ----------

    /// Write a recording's new state from the uploader. A failed write keeps
    /// the change in memory as unsaved, stops the attempt (the error goes back
    /// to the uploader) and shows the error with Try again.
    pub fn put(&self, rec: &RecordingState) -> Result<(), String> {
        let result = self.lock().queue.put(&self.store, rec);
        if let Err(e) = &result {
            self.state_save_failed(&rec.id, e);
        }
        result
    }

    /// Apply an event and write the entry. On a failed write the change is
    /// kept as unsaved (a stop, a local failure: never lost, never uploaded
    /// until written), and the caller gets the error, so nothing that depends
    /// on it (a deletion) follows.
    pub fn apply(&self, id: &str, event: Event) -> Result<RecordingState, String> {
        self.apply_with(id, event, OnFail::Keep)
    }

    pub fn apply_with(&self, id: &str, event: Event, on_fail: OnFail) -> Result<RecordingState, String> {
        let result = self.lock().queue.apply(&self.store, id, event, Utc::now(), on_fail);
        if let Err(e) = &result {
            self.state_save_failed(id, e);
        }
        result
    }

    fn state_save_failed(&self, id: &str, error: &str) {
        log::error!("could not write the state of {id}: {error}");
        self.lock().notice = Some(Notice::new("recorder.error.stateSave").arg("error", error));
    }

    /// "Try again" on a failed state write, and every tick: write the
    /// unsaved entries again.
    pub fn retry_save(&self) {
        let result = self.lock().queue.retry(&self.store);
        {
            let mut inner = self.lock();
            match result {
                Ok(()) => {
                    if inner.notice.as_ref().is_some_and(|n| n.key == "recorder.error.stateSave") {
                        inner.notice = None;
                    }
                }
                Err(e) => inner.notice = Some(Notice::new("recorder.error.stateSave").arg("error", e)),
            }
        }
        self.wake.notify_one();
        self.changed();
    }

    pub fn signed_out(&self) {
        let host = {
            let mut inner = self.lock();
            inner.credential = None;
            inner.profile.host.clone()
        };
        if let Some(h) = host {
            let _ = Keychain.delete(&h);
        }
        self.changed();
    }
}

/// The token, the host and the user it was issued for, when connected.
/// Only while the credential's token id is the profile's binding.
fn credentials(inner: &Inner) -> Option<(String, String, Owner)> {
    let c = inner.credential.as_ref()?;
    if inner.profile.connection.as_ref()?.token_id != c.token_id {
        return None;
    }
    Some((c.token.clone(), inner.profile.host.clone()?, inner.profile.owner()?))
}

// ---------- background loops ----------

/// Upload what is due, one recording at a time; tick the clock; poll the
/// server's status of fresh confirms. Woken by `wake` or the next retry time.
///
/// A token goes only to the install it was issued for, and only for
/// recordings of the user it belongs to (`belongs`). Everything else waits in
/// the queue with the reason on its row.
pub async fn uploader_loop(app: Arc<App>) {
    let mut last_status_poll = Instant::now() - Duration::from_secs(3600);
    loop {
        tick(&app);
        let job = {
            let inner = app.lock();
            let now = Utc::now();
            credentials(&inner).and_then(|(token, host, me)| {
                let c = Conn { host: &host, user: &me };
                inner.queue.next_upload(&c, now).cloned().map(|r| (token.clone(), host.clone(), r))
            })
        };
        if let Some((token, host, mut rec)) = job {
            app.lock().uploading = Some(rec.id.clone());
            app.changed();
            let outcome = match Api::new(&host) {
                Ok(api) => {
                    let path = app.store.audio_path(&rec.id);
                    let app2 = app.clone();
                    let mut changed = move |r: &RecordingState| {
                        let saved = app2.put(r);
                        app2.changed();
                        saved
                    };
                    uploader::attempt(&mut rec, &api, &token, &path, &mut changed).await
                }
                Err(_) => uploader::Outcome::Failed,
            };
            {
                let mut inner = app.lock();
                inner.uploading = None;
                inner.online = rec.pending_reason != Some(PendingReason::Network);
            }
            if rec.pending_reason == Some(PendingReason::SignedOut) {
                app.signed_out();
            }
            log::info!("upload of {}: {outcome:?}", rec.id);
            app.changed();
            continue;
        }
        if last_status_poll.elapsed() >= Duration::from_secs(60) {
            last_status_poll = Instant::now();
            poll_server_status(&app).await;
        }
        let wait = {
            let inner = app.lock();
            let now = Utc::now();
            inner
                .queue
                .items
                .iter()
                .filter(|r| r.is_unconfirmed())
                .filter_map(|r| r.next_attempt_at)
                .map(|at| (at - now).to_std().unwrap_or(Duration::ZERO))
                .min()
                .unwrap_or(Duration::from_secs(30))
                .clamp(Duration::from_millis(200), Duration::from_secs(30))
        };
        tokio::select! {
            _ = app.wake.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

/// The clock: Warn, AskUser, and the deletion after a confirm. Each change is
/// written before anything follows from it; a deletion is written as Deleted
/// first, and the audio removed after. A Deleted entry whose audio is still
/// there (a removal that failed) is removed again.
fn tick(app: &Arc<App>) {
    // Changes that could not be written are written again first.
    if app.lock().queue.first_unsaved_error().is_some() {
        app.retry_save();
    }
    let now = Utc::now();
    let mut delete = Vec::new();
    let mut ask = None;
    let mut any = false;
    let mut save_error = None;
    {
        let mut inner = app.lock();
        let unsaved: Vec<String> =
            inner.queue.items.iter().filter(|r| !inner.queue.is_saved(&r.id)).map(|r| r.id.clone()).collect();
        for rec in inner.queue.items.iter_mut() {
            // An unsaved entry waits until its state is on the disk.
            if unsaved.contains(&rec.id) {
                continue;
            }
            let before = rec.clone();
            let out = rec.tick(now);
            if *rec != before {
                if let Err(e) = app.store.save(rec) {
                    *rec = before;
                    save_error = Some((rec.id.clone(), e.to_string()));
                    continue;
                }
                any |= rec.status != before.status;
            }
            if out.delete_file {
                delete.push(rec.id.clone());
            }
            if out.ask && ask.is_none() {
                ask = Some(rec.id.clone());
            }
        }
        if inner.ask.is_none() {
            // A question still open from before a restart comes back.
            inner.ask = ask.clone().or_else(|| {
                inner.queue.items.iter().find(|r| r.status == Status::AskUser).map(|r| r.id.clone())
            });
            any |= inner.ask.is_some() && ask.is_some();
        }
        for r in inner.queue.items.iter().filter(|r| r.status == Status::Deleted && !unsaved.contains(&r.id)) {
            if app.store.audio_path(&r.id).exists() {
                delete.push(r.id.clone());
            }
        }
    }
    if let Some((id, e)) = save_error {
        app.state_save_failed(&id, &e);
        any = true;
    }
    for id in delete {
        let deleted = {
            let inner = app.lock();
            inner.queue.items.iter().any(|r| r.id == id && r.status == Status::Deleted) && inner.queue.is_saved(&id)
        };
        // Deleted must be on the disk before the audio goes.
        if !deleted && app.apply_with(&id, Event::FileDeleted, OnFail::Revert).is_err() {
            continue;
        }
        if let Err(e) = app.store.delete_audio(&id) {
            log::warn!("could not delete the audio of {id}: {e}; trying again later");
        }
        any = true;
    }
    if ask.is_some() {
        crate::windows::show_main(&app.handle);
    }
    if any {
        app.changed();
    }
}

/// The server's status of recordings confirmed in the last day, with this
/// connection's token, for this connection's recordings only.
async fn poll_server_status(app: &Arc<App>) {
    let Some((token, host, recent)) = ({
        let inner = app.lock();
        let cutoff = Utc::now() - chrono::Duration::hours(24);
        credentials(&inner).map(|(token, host, me)| {
            let c = Conn { host: &host, user: &me };
            let recent: Vec<RecordingState> = inner.queue.status_targets(&c, cutoff).into_iter().cloned().collect();
            (token.clone(), host.clone(), recent)
        })
    }) else {
        return;
    };
    let Ok(api) = Api::new(&host) else { return };
    for mut rec in recent {
        match uploader::refresh_server_status(&mut rec, &api, &token).await {
            Ok(true) => {
                let _ = app.put(&rec);
                app.changed();
            }
            Ok(false) => {}
            Err(ApiError::Unauthorized) => {
                app.signed_out();
                return;
            }
            Err(_) => {}
        }
    }
}

/// Meter values and the clock, ten times a second while recording; a write
/// failure ends the recording at once; a lost or returning source updates
/// the window.
pub async fn levels_loop(app: Arc<App>) {
    let mut ticks = 0u64;
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let (payload, failure, sources_changed) = {
            let mut inner = app.lock();
            let Some(a) = inner.active.as_mut() else { continue };
            let Some(r) = a.recording.as_ref() else { continue };
            let (mic, system) = r.levels.get();
            let payload = serde_json::json!({ "mic": mic, "system": system, "elapsed_s": a.started.elapsed().as_secs() });
            let failure = r.failure();
            let word = |s: Option<crate::audio::capture::SourceState>, was: &'static str| match s {
                Some(crate::audio::capture::SourceState::On) => "on",
                Some(crate::audio::capture::SourceState::Lost) => "lost",
                None => was,
            };
            let (m, sy) = r.source_states();
            let next = Sources { microphone: word(m, a.sources.microphone), system_audio: word(sy, a.sources.system_audio) };
            let changed = next.microphone != a.sources.microphone || next.system_audio != a.sources.system_audio;
            a.sources = next;
            (payload, failure, changed)
        };
        if let Some(error) = failure {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move { app2.local_failure(error).await });
            continue;
        }
        let _ = app.handle.emit_to("main", "levels", payload);
        if sources_changed {
            app.changed();
        }
        ticks += 1;
        if ticks % 10 == 0 {
            let snap = app.snapshot();
            crate::tray::refresh(&app.handle, &snap, &app.strings());
        }
    }
}

// ---------- connecting ----------

impl App {
    pub fn set_host(&self, input: &str) -> Result<String, String> {
        let host = connect::normalise_host(input).map_err(|e| e.key().to_string())?;
        {
            let mut inner = self.lock();
            if inner.profile.host.as_deref() != Some(&host) {
                inner.profile.connection = None;
                inner.credential = None;
            }
            inner.profile.host = Some(host.clone());
            inner.connect_error = None;
            let _ = inner.profile.save(&self.data_dir);
        }
        self.changed();
        Ok(host)
    }

    pub fn start_connect(self: &Arc<App>) -> Result<String, String> {
        let host = self.lock().profile.host.clone().ok_or("recorder.connect.host.empty")?;
        if let Some(c) = self.lock().connect.take() {
            c.cancel.store(true, Ordering::SeqCst);
        }
        let pkce = Pkce::generate();
        let code = connect::pairing_code(&pkce.challenge);
        let device = connect::device_name(&computer_name());
        let url = connect::connect_url(&host, &pkce.challenge, &device);
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut inner = self.lock();
            inner.connect = Some(ConnectAttempt { pkce: pkce.clone(), pairing_code: code.clone(), url: url.clone(), cancel: cancel.clone() });
            inner.connect_error = None;
        }
        open_url(&self.handle, &url);
        self.changed();
        let app = self.clone();
        tauri::async_runtime::spawn(async move { app.poll_connect(host, pkce, cancel).await });
        Ok(code)
    }

    pub fn reopen_connect(&self) {
        if let Some(url) = self.lock().connect.as_ref().map(|c| c.url.clone()) {
            open_url(&self.handle, &url);
        }
    }

    pub fn cancel_connect(&self) {
        if let Some(c) = self.lock().connect.take() {
            c.cancel.store(true, Ordering::SeqCst);
        }
        self.changed();
    }

    async fn poll_connect(self: Arc<App>, host: String, pkce: Pkce, cancel: Arc<AtomicBool>) {
        let api = match Api::new(&host) {
            Ok(a) => a,
            Err(_) => return self.connect_failed(&cancel, Notice::new("recorder.connect.failed").arg("host", host_label(&host))),
        };
        let deadline = Instant::now() + Duration::from_secs(connect::POLL_GIVE_UP_SECS);
        let mut unreachable = 0;
        let mut reached = false;
        while !cancel.load(Ordering::SeqCst) {
            if Instant::now() > deadline {
                return self.connect_failed(&cancel, Notice::new("recorder.connect.expired"));
            }
            let wait = match api.poll_token(&pkce).await {
                PollResult::Token(token) => return self.connected(&host, token, &cancel),
                PollResult::Pending { retry_after } => {
                    reached = true;
                    retry_after
                }
                PollResult::RateLimited { retry_after } => retry_after,
                PollResult::Gone { code } => {
                    let key = if code == "denied" { "recorder.connect.denied" } else { "recorder.connect.expired" };
                    return self.connect_failed(&cancel, Notice::new(key));
                }
                PollResult::Refused { .. } => {
                    return self.connect_failed(&cancel, Notice::new("recorder.connect.failed").arg("host", host_label(&host)));
                }
                PollResult::TryAgain => {
                    unreachable += 1;
                    if !reached && unreachable >= 3 {
                        return self
                            .connect_failed(&cancel, Notice::new("recorder.connect.failed").arg("host", host_label(&host)));
                    }
                    connect::POLL_INTERVAL_SECS
                }
            };
            tokio::time::sleep(Duration::from_secs(wait.clamp(1, 30))).await;
        }
    }

    fn connect_failed(&self, cancel: &AtomicBool, notice: Notice) {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut inner = self.lock();
            inner.connect = None;
            inner.connect_error = Some(notice);
        }
        self.changed();
    }

    /// The binding is written first, then the Keychain (`credentials::bind`).
    /// A failed profile write aborts the connect and keeps the old binding.
    fn connected(&self, host: &str, token: crate::contract::RecorderToken, cancel: &AtomicBool) {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        let bound = {
            let mut inner = self.lock();
            let data_dir = self.data_dir.clone();
            let save = move |p: &Profile| p.save(&data_dir);
            let result = credentials::bind(&mut inner.profile, &save, &Keychain, host, &token);
            match &result {
                Ok(c) => inner.credential = Some(c.clone()),
                // The new binding is on the disk without its token: disconnected.
                Err(credentials::BindError::Keychain(_)) => inner.credential = None,
                Err(credentials::BindError::Profile(_)) => {}
            }
            result
        };
        if let Err(e) = bound {
            log::error!("connect: {e:?}");
            return self.connect_failed(cancel, Notice::new("recorder.connect.failed").arg("host", host_label(host)));
        }
        let ids: Vec<String> = {
            let mut inner = self.lock();
            inner.connect = None;
            inner.connect_error = None;
            inner.online = true;
            inner.queue.items.iter().map(|r| r.id.clone()).collect()
        };
        for id in ids {
            let _ = self.apply(&id, Event::Reconnected);
        }
        crate::windows::apply_branding(&self.handle, &self.snapshot());
        crate::windows::show_main(&self.handle);
        self.wake.notify_one();
        self.changed();
    }

    /// Revoke the token on the server, then forget it here. `local_only`
    /// skips the server when it cannot be reached.
    pub async fn disconnect(&self, local_only: bool) -> Result<(), String> {
        let (host, token, token_id) = {
            let inner = self.lock();
            (
                inner.profile.host.clone(),
                inner.credential.as_ref().map(|c| c.token.clone()),
                inner.profile.connection.as_ref().map(|c| c.token_id.clone()),
            )
        };
        if let (false, Some(h), Some(t), Some(id)) = (local_only, &host, &token, &token_id) {
            let api = Api::new(h).map_err(|_| "recorder.disconnect.failed".to_string())?;
            match api.revoke(t, id).await {
                Ok(()) | Err(ApiError::Unauthorized) | Err(ApiError::Status { status: 404, .. }) => {}
                Err(_) => return Err("recorder.disconnect.failed".into()),
            }
        }
        {
            // The binding goes first: a Keychain entry without a binding is never used.
            let mut inner = self.lock();
            let mut next = inner.profile.clone();
            next.connection = None;
            next.save(&self.data_dir).map_err(|_| "recorder.disconnect.failed".to_string())?;
            inner.profile = next;
            inner.credential = None;
        }
        if let Some(h) = &host {
            if let Err(e) = Keychain.delete(h) {
                log::warn!("disconnect: the Keychain entry stays (unused without a binding): {e}");
            }
        }
        self.changed();
        Ok(())
    }
}

fn host_label(host: &str) -> String {
    host.split("://").nth(1).unwrap_or(host).to_string()
}

pub fn open_url(handle: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = handle.opener().open_url(url, None::<&str>) {
        log::warn!("could not open the browser: {e}");
    }
}

/// The name the user gave this computer, for the connect page and Recorders.
fn computer_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default()
}

// ---------- recording ----------

impl App {
    pub async fn start_recording(self: &Arc<App>, title: String) -> Result<(), String> {
        let perms = permissions::current();
        let wanted = Wanted {
            microphone: perms.microphone == Permission::Granted,
            system_audio: perms.system_audio == Permission::Granted,
        };
        if !wanted.microphone && !wanted.system_audio {
            return Err("recorder.error.noSource".into());
        }
        let title = {
            let t: String = title.trim().chars().take(crate::contract::MAX_TITLE_CHARS).collect();
            if t.is_empty() {
                self.strings().get("recorder.title.fallback", &[])
            } else {
                t
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut inner = self.lock();
            if inner.active.is_some() {
                return Ok(());
            }
            let host = inner.profile.host.clone().ok_or("recorder.error.noHost")?;
            let mut rec = RecordingState::new(id.clone(), host, title.clone(), Utc::now());
            // The connected user owns it; recorded while disconnected, nobody
            // does yet, and the user uploads it as themselves later.
            rec.owner = inner.profile.owner();
            self.store.save(&rec).map_err(|_| "recorder.error.file".to_string())?;
            inner.queue.items.insert(0, rec);
            inner.notice = None;
            inner.active = Some(Active {
                id: id.clone(),
                recording: None,
                started: Instant::now(),
                started_at: Utc::now(),
                title,
                sources: Sources {
                    microphone: if wanted.microphone { "starting" } else { "off" },
                    system_audio: if wanted.system_audio { "starting" } else { "off" },
                },
                stopping: false,
            });
        }
        self.changed();
        let path = self.store.audio_path(&id);
        let feed = self.live_feed.clone();
        let started = tauri::async_runtime::spawn_blocking(move || recorder::start(&path, feed, wanted))
            .await
            .map_err(|_| "recorder.error.file".to_string())?;
        match started {
            Ok(rec) => {
                {
                    let mut inner = self.lock();
                    if let Some(a) = inner.active.as_mut() {
                        a.sources = Sources {
                            microphone: if rec.sources.microphone.is_ok() { "on" } else { "off" },
                            system_audio: if rec.sources.system_audio.is_ok() { "on" } else { "off" },
                        };
                        a.started = rec.started;
                        a.started_at = Utc::now();
                        a.recording = Some(rec);
                    }
                }
                if self.lock().profile.live_enabled() {
                    self.start_live();
                }
                self.changed();
                Ok(())
            }
            Err(e) => {
                log::error!("could not start the recording: {e}");
                {
                    let mut inner = self.lock();
                    inner.active = None;
                    inner.queue.items.retain(|r| r.id != id);
                }
                let _ = self.store.forget(&id);
                self.changed();
                Err(match e {
                    recorder::StartError::NoSource { .. } => "recorder.error.noSource".into(),
                    recorder::StartError::File(_) => "recorder.error.file".into(),
                })
            }
        }
    }

    pub async fn stop_recording(self: &Arc<App>) -> Result<(), String> {
        let (id, recording) = {
            let mut inner = self.lock();
            let Some(a) = inner.active.as_mut() else { return Ok(()) };
            if a.stopping {
                return Ok(());
            }
            let Some(r) = a.recording.take() else { return Ok(()) };
            a.stopping = true;
            (a.id.clone(), r)
        };
        self.stop_live();
        self.changed();
        let path = self.store.audio_path(&id);
        let finished = tauri::async_runtime::spawn_blocking(move || {
            let done = recording.finish()?;
            let (sha256, size) = crate::queue::chunks::hash_file(&path)?;
            Ok::<_, std::io::Error>((done, sha256, size))
        })
        .await
        .map_err(|_| "recorder.error.file".to_string())?;
        let result = match finished {
            Ok((done, sha256, size)) => {
                let _ = self.apply(&id, Event::Gaps(done.gaps));
                self.apply(
                    &id,
                    Event::Stopped { at: Utc::now(), duration_s: done.duration_s.round() as u64, sha256, size_bytes: size },
                )
                .map(|_| ())
                .map_err(|_| "recorder.error.stateSave".to_string())
            }
            Err(e) => {
                self.mark_failed_local(&id, e.to_string());
                Err("recorder.error.write".to_string())
            }
        };
        self.lock().active = None;
        self.wake.notify_one();
        self.changed();
        result
    }

    /// A write failed while recording (a full disk): stop the capture now,
    /// keep the partial file, and show the error with Save elsewhere.
    pub async fn local_failure(self: &Arc<App>, error: String) {
        let (id, recording) = {
            let mut inner = self.lock();
            let Some(a) = inner.active.as_mut() else { return };
            let Some(r) = a.recording.take() else { return };
            a.stopping = true;
            (a.id.clone(), r)
        };
        self.stop_live();
        let _ = tauri::async_runtime::spawn_blocking(move || recording.finish()).await;
        self.mark_failed_local(&id, error);
        self.lock().active = None;
        crate::windows::show_main(&self.handle);
        self.changed();
    }

    fn mark_failed_local(&self, id: &str, error: String) {
        let duration = crate::audio::ogg_opus::duration_of(&self.store.audio_path(id)).unwrap_or(0.0);
        log::error!("{id}: the recording could not be written: {error}");
        let _ = self.apply(id, Event::FailedLocal { at: Utc::now(), error, duration_s: duration.round() as u64 });
    }

    pub fn is_busy(&self) -> bool {
        let inner = self.lock();
        // An upload that can still make progress keeps the app in the menu bar;
        // one waiting for a person (signed out, refused) does not.
        inner.active.is_some()
            || inner.queue.items.iter().any(|r| {
                r.is_unconfirmed()
                    && !matches!(r.pending_reason, Some(PendingReason::SignedOut) | Some(PendingReason::Rejected { .. }))
            })
    }

    pub fn request_permissions(&self) -> Permissions {
        let mic = match permissions::microphone() {
            Permission::NotDetermined => permissions::request_microphone(),
            p => p,
        };
        let system = match permissions::system_audio() {
            Permission::NotDetermined => permissions::request_system_audio(),
            p => p,
        };
        {
            let mut inner = self.lock();
            inner.profile.permissions_asked = true;
            let _ = inner.profile.save(&self.data_dir);
        }
        self.changed();
        Permissions { microphone: mic, system_audio: system }
    }
}

// ---------- the queue, from the user ----------

impl App {
    pub fn try_now(&self, id: &str) {
        let _ = self.apply(id, Event::TryNow);
        self.wake.notify_one();
        self.changed();
    }

    pub fn keep_trying(&self, id: &str) {
        if self.apply(id, Event::KeepTrying).is_ok() {
            let mut inner = self.lock();
            if inner.ask.as_deref() == Some(id) {
                inner.ask = None;
            }
        }
        self.wake.notify_one();
        self.changed();
    }

    /// Copy the file to `dest` (never into the queue), sync and check the
    /// copy, write the entry as Saved elsewhere, and only then delete the
    /// queue's own copy. Any step that fails leaves the queue as it was.
    pub fn save_elsewhere(&self, id: &str, dest: PathBuf) -> Result<(), String> {
        let rec = self.lock().queue.items.iter().find(|r| r.id == id).cloned().ok_or("recorder.ask.saveFailed")?;
        if !rec.can_save_elsewhere() {
            return Err("recorder.ask.saveFailed".into());
        }
        let expected = if rec.status == Status::FailedLocal { None } else { rec.sha256.as_deref() };
        self.store.export(id, &dest, expected).map_err(|e| match e {
            ExportError::InsideQueue => "recorder.ask.insideQueue".to_string(),
            _ => "recorder.ask.saveFailed".to_string(),
        })?;
        self.apply_with(id, Event::SavedElsewhere { path: dest.display().to_string() }, OnFail::Revert)
            .map_err(|_| "recorder.error.stateSave".to_string())?;
        if let Err(e) = self.store.delete_audio(id) {
            log::warn!("{id}: saved elsewhere, but the queue copy stays: {e}");
        }
        {
            let mut inner = self.lock();
            if inner.ask.as_deref() == Some(id) {
                inner.ask = None;
            }
        }
        self.changed();
        Ok(())
    }

    /// A damaged entry's audio, saved elsewhere. The state file is set aside
    /// as `<id>.json-damaged` (kept, not listed), the queue copy removed.
    pub fn save_damaged_elsewhere(&self, id: &str, dest: PathBuf) -> Result<(), String> {
        self.store.export(id, &dest, None).map_err(|e| match e {
            ExportError::InsideQueue => "recorder.ask.insideQueue".to_string(),
            _ => "recorder.ask.saveFailed".to_string(),
        })?;
        let json = self.store.dir().join(format!("{id}.json"));
        std::fs::rename(&json, json.with_extension("json-damaged")).map_err(|_| "recorder.ask.saveFailed".to_string())?;
        let _ = crate::queue::store::sync_dir(self.store.dir());
        let _ = self.store.delete_audio(id);
        self.lock().damaged.retain(|d| d.id != id);
        self.changed();
        Ok(())
    }

    /// Read a damaged state file again; if it parses now, it joins the queue.
    pub fn retry_damaged(&self, id: &str) {
        match self.store.read(id) {
            Ok(rec) => {
                let mut inner = self.lock();
                inner.damaged.retain(|d| d.id != id);
                inner.queue.items.push(rec);
                inner.queue.items.sort_by(|a, b| b.started_at.cmp(&a.started_at));
            }
            Err(error) => {
                if let Some(d) = self.lock().damaged.iter_mut().find(|d| d.id == id) {
                    d.error = error;
                }
            }
        }
        let recording = self.lock().queue.items.iter().any(|r| r.id == id && r.status == Status::Recording);
        if recording {
            self.recover(id);
        }
        self.changed();
    }

    /// Read an unreadable file again.
    pub fn retry_unreadable(&self, id: &str) {
        self.recover(id);
        self.wake.notify_one();
        self.changed();
    }

    /// Upload a recording that has no owner (recovered, or recorded while
    /// disconnected) as the connected user, to the connected install.
    pub fn claim(&self, id: &str) -> Result<(), String> {
        let (owner, host) = {
            let inner = self.lock();
            (inner.profile.owner().ok_or("recorder.error.noHost")?, inner.profile.host.clone().ok_or("recorder.error.noHost")?)
        };
        {
            let mut inner = self.lock();
            let rec = inner.queue.items.iter_mut().find(|r| r.id == id).ok_or("no such recording")?;
            if rec.owner.is_some() {
                return Err("already owned".into());
            }
            let mut next = rec.clone();
            next.host = host;
            next.apply(Event::Claim(owner), Utc::now());
            if let Err(e) = inner.queue.replace(&self.store, next, OnFail::Revert) {
                drop(inner);
                self.state_save_failed(id, &e);
                return Err("recorder.error.stateSave".into());
            }
        }
        self.wake.notify_one();
        self.changed();
        Ok(())
    }

    /// "Save audio to…": a checked copy elsewhere; the entry does not change.
    pub fn export_audio(&self, id: &str, dest: PathBuf) -> Result<(), String> {
        // A file still being recorded is not finished; a copy would be cut short.
        let status = self.lock().queue.get(id).map(|r| r.status);
        if matches!(status, Some(Status::Recording) | Some(Status::Discarding)) {
            return Err("recorder.delete.busy".into());
        }
        let expected = self.lock().queue.get(id).and_then(|r| {
            (r.status != Status::FailedLocal).then(|| r.sha256.clone()).flatten()
        });
        self.store.export(id, &dest, expected.as_deref()).map(|_| ()).map_err(|e| match e {
            ExportError::InsideQueue => "recorder.ask.insideQueue".to_string(),
            _ => "recorder.ask.saveFailed".to_string(),
        })
    }

    /// "Delete from this Mac": the local copy only. A confirmed recording
    /// becomes Deleted (the library has it); an unconfirmed one is removed
    /// entirely, and only with `confirmed` from the window's named question.
    /// Never while it records or uploads.
    pub fn delete_local(&self, id: &str, confirmed: bool) -> Result<(), String> {
        let (status, active, saved) = {
            let inner = self.lock();
            let r = inner.queue.get(id).ok_or("no such recording")?;
            (r.status, inner.uploading.as_deref() == Some(id), inner.queue.is_saved(id))
        };
        if active || matches!(status, Status::Recording | Status::Uploading) {
            return Err("recorder.delete.busy".into());
        }
        if !saved {
            return Err("recorder.error.stateSave".into());
        }
        match status {
            Status::Confirmed => {
                self.apply_with(id, Event::FileDeleted, OnFail::Revert).map_err(|_| "recorder.error.stateSave".to_string())?;
                self.store.delete_audio(id).map_err(|e| e.to_string())?;
            }
            Status::Deleted | Status::SavedElsewhere => return Err("recorder.delete.noFile".into()),
            _ if !confirmed => return Err("recorder.delete.needsConfirm".into()),
            _ => {
                let result = {
                    let mut inner = self.lock();
                    let r = inner.queue.discard(&self.store, &self.store, id, false, Utc::now());
                    if r.is_ok() && inner.ask.as_deref() == Some(id) {
                        inner.ask = None;
                    }
                    r
                };
                if let Err(e) = result {
                    log::warn!("{id}: delete from this Mac: {e:?}");
                    self.changed();
                    return Err(match e {
                        crate::queue::DiscardError::Busy => "recorder.delete.busy",
                        crate::queue::DiscardError::NotSaved(_) | crate::queue::DiscardError::Unsaved => "recorder.error.stateSave",
                        _ => "recorder.delete.failed",
                    }
                    .into());
                }
            }
        }
        self.changed();
        Ok(())
    }

    /// "Upload" on a recording recovery finished: the user says it may go.
    pub fn review(&self, id: &str) -> Result<(), String> {
        self.apply_with(id, Event::Review, OnFail::Revert).map_err(|_| "recorder.error.stateSave".to_string())?;
        self.wake.notify_one();
        self.changed();
        Ok(())
    }

    /// Only a recording whose audio is gone leaves the list.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if self.store.audio_path(id).exists() {
            return Err("not removable".into());
        }
        self.store.forget(id).map_err(|e| e.to_string())?;
        self.lock().queue.items.retain(|r| r.id != id);
        self.changed();
        Ok(())
    }
}

// ---------- the live transcript ----------

impl App {
    pub fn start_live(self: &Arc<App>) {
        let model = {
            let mut inner = self.lock();
            if inner.live.is_some() || inner.active.as_ref().and_then(|a| a.recording.as_ref()).is_none() {
                return;
            }
            inner.live_hidden = false;
            inner.live_text = LiveTranscript::default();
            models::usable(&inner.profile.model).to_string()
        };
        let offset_s = self
            .lock()
            .active
            .as_ref()
            .map(|a| a.started.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let app = self.clone();
        let id = {
            let mut inner = self.lock();
            inner.live_sessions += 1;
            inner.live_sessions
        };
        let session = LiveSession::start(self.models_dir.clone(), model, self.live_feed.clone(), offset_s, id, move |update| {
            // Runs only while the session is alive (`LiveSession` guards it).
            app.lock().live_text.apply(&update);
            let _ = app.handle.emit_to("live", "live", &update);
        });
        self.lock().live = Some(session);
        crate::windows::show_live(&self.handle);
    }

    /// Stop the preview and drop its text: in Rust, and in the live window,
    /// which gets an empty `stopped` update. Nothing of it is kept.
    pub fn stop_live(&self) {
        let session = self.lock().live.take();
        // The stopped update is numbered after the session's last one, and the
        // kept state says stopped too, so a window that opens now agrees.
        let stopped = match session {
            Some(s) => s.stop(),
            None => {
                let t = &self.lock().live_text;
                LiveUpdate::stopped(t.session, t.seq + 1)
            }
        };
        self.lock().live_text.apply(&stopped);
        let _ = self.handle.emit_to("live", "live", &stopped);
        crate::windows::hide_live(&self.handle);
    }

    pub fn set_live(self: &Arc<App>, enabled: bool) {
        {
            let mut inner = self.lock();
            inner.profile.live_transcript = Some(enabled);
            let _ = inner.profile.save(&self.data_dir);
        }
        if enabled {
            self.start_live();
        } else {
            self.stop_live();
        }
        self.changed();
    }

    pub fn show_live(self: &Arc<App>) {
        let running = self.lock().live.is_some();
        if running {
            {
                let mut inner = self.lock();
                inner.live_hidden = false;
                if let Some(s) = inner.live.as_ref() {
                    s.paused.store(false, Ordering::SeqCst);
                }
            }
            crate::windows::show_live(&self.handle);
        } else {
            self.start_live();
        }
        self.changed();
    }

    /// Hide only the preview; the recording goes on. Decoding pauses while hidden.
    pub fn hide_live(&self) {
        {
            let mut inner = self.lock();
            inner.live_hidden = true;
            if let Some(s) = inner.live.as_ref() {
                s.paused.store(true, Ordering::SeqCst);
            }
        }
        crate::windows::hide_live(&self.handle);
        self.changed();
    }

    pub fn pause_live(&self, paused: bool) {
        if let Some(s) = self.lock().live.as_ref() {
            s.paused.store(paused, Ordering::SeqCst);
        }
    }

    pub fn live_state(&self) -> LiveTranscript {
        self.lock().live_text.clone()
    }

    pub fn set_model(self: &Arc<App>, id: &str) {
        if models::spec(id).is_none() {
            return;
        }
        let restart = {
            let mut inner = self.lock();
            inner.profile.model = id.into();
            let _ = inner.profile.save(&self.data_dir);
            inner.live.is_some()
        };
        if restart {
            self.stop_live();
            self.start_live();
        }
        self.changed();
    }

    pub fn download_model(self: &Arc<App>, id: &str) {
        let Some(spec) = models::spec(id) else { return };
        {
            let mut inner = self.lock();
            if inner.downloads.get(id).is_some_and(|d| !d.failed) {
                return;
            }
            inner.downloads.insert(id.into(), Download { done: 0, total: spec.total_size(), failed: false });
        }
        self.changed();
        let app = self.clone();
        std::thread::spawn(move || {
            let cancel = AtomicBool::new(false);
            let mut last = Instant::now();
            let result = models::download(&app.models_dir, spec, &cancel, &mut |p| {
                app.lock().downloads.insert(spec.id.into(), Download { done: p.done, total: p.total, failed: false });
                if last.elapsed() >= Duration::from_millis(250) || p.done == p.total {
                    last = Instant::now();
                    app.changed();
                }
            });
            match result {
                Ok(()) => {
                    app.lock().downloads.remove(spec.id);
                    // A live session that waited for this model starts over.
                    let waiting = {
                        let inner = app.lock();
                        inner.live.is_some()
                            && inner.profile.model == spec.id
                            && inner.live_text.state == "needs_model"
                    };
                    if waiting {
                        app.stop_live();
                        app.start_live();
                    }
                }
                Err(e) => {
                    log::warn!("download of {}: {e}", spec.id);
                    if let Some(d) = app.lock().downloads.get_mut(spec.id) {
                        d.failed = true;
                    }
                }
            }
            app.changed();
        });
    }
}
