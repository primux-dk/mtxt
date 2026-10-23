//! The recorder's state and what changes it: connecting, recording, the
//! upload queue, the live transcript. The windows read it as one snapshot,
//! sent after every change; they never hold state of their own beyond what
//! is on screen.

use crate::api::{Api, ApiError, PollResult};
use crate::audio::recorder::{self, LiveFeed, Recording, Wanted};
use crate::connect::{self, Pkce};
use crate::live::{models, LiveSession, LiveUpdate};
use crate::permissions::{self, Permission, Permissions};
use crate::profile::{Connection, Profile};
use crate::queue::store::Store;
use crate::queue::{uploader, Event, PendingReason, RecordingState, Status};
use crate::{keychain, locale};
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
    pub token: Option<String>,
    pub queue: Vec<RecordingState>,
    pub active: Option<Active>,
    pub connect: Option<ConnectAttempt>,
    pub connect_error: Option<Notice>,
    pub online: bool,
    pub downloads: HashMap<String, Download>,
    pub live: Option<LiveSession>,
    pub live_update: Option<LiveUpdate>,
    pub live_hidden: bool,
    /// The recording whose 7-day question is open.
    pub ask: Option<String>,
    pub notice: Option<Notice>,
    pub uploading: Option<String>,
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
    /// `on`, `off` (not allowed or failed) or `starting`.
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
    pub permissions: Permissions,
    pub permissions_asked: bool,
    pub recording: Option<RecordingView>,
    pub queue: Vec<QueueItem>,
    pub online: bool,
    pub live: LiveView,
    pub ask: Option<QueueItem>,
    pub notice: Option<Notice>,
    pub version: &'static str,
}

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
        let token = profile.host.as_deref().and_then(keychain::load);
        let queue = store.load_all();
        let app = Arc::new(App {
            handle,
            data_dir,
            models_dir,
            store,
            inner: Mutex::new(Inner {
                profile,
                token,
                queue,
                active: None,
                connect: None,
                connect_error: None,
                online: true,
                downloads: HashMap::new(),
                live: None,
                live_update: None,
                live_hidden: false,
                ask: None,
                notice: None,
                uploading: None,
            }),
            wake: Notify::new(),
            live_feed: Arc::new(LiveFeed::default()),
        });
        app.recover_interrupted();
        Ok(app)
    }

    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A recording left in `Recording` by a crash or a forced quit: the file
    /// plays up to its last flushed second, so it is finished and queued.
    fn recover_interrupted(&self) {
        let mut inner = self.lock();
        let mut gone = Vec::new();
        for rec in inner.queue.iter_mut().filter(|r| r.status == Status::Recording) {
            let path = self.store.audio_path(&rec.id);
            match (crate::audio::ogg_opus::duration_of(&path), crate::queue::chunks::hash_file(&path)) {
                (Ok(duration), Ok((sha256, size))) if size > 0 => {
                    let at = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .map(DateTime::<Utc>::from)
                        .unwrap_or_else(|_| Utc::now());
                    rec.apply(Event::Stopped { at, duration_s: duration.round() as u64, sha256, size_bytes: size }, Utc::now());
                    let _ = self.store.save(rec);
                    log::info!("recovered interrupted recording {}", rec.id);
                }
                _ => gone.push(rec.id.clone()),
            }
        }
        // No audio reached the disk: there is nothing to keep.
        for id in gone {
            let _ = self.store.forget(&id);
            inner.queue.retain(|r| r.id != id);
        }
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
        let queue: Vec<QueueItem> = inner.queue.iter().take(QUEUE_SHOWN).map(|r| self.item(inner, r)).collect();
        let ask = inner.ask.as_ref().and_then(|id| inner.queue.iter().find(|r| &r.id == id)).map(|r| self.item(inner, r));
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
            signed_out: p.connection.is_some() && inner.token.is_none(),
            language: Self::language(inner),
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
                model: p.model.clone(),
                models: models::ALL
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

    /// Write a recording's new state, unless the user ended it meanwhile.
    pub fn put(&self, rec: &RecordingState) {
        let mut inner = self.lock();
        if let Some(slot) = inner.queue.iter_mut().find(|r| r.id == rec.id) {
            if matches!(slot.status, Status::SavedElsewhere | Status::Deleted) && slot.status != rec.status {
                return;
            }
            let snooze = slot.ask_snoozed_until.max(rec.ask_snoozed_until);
            *slot = rec.clone();
            slot.ask_snoozed_until = snooze;
            if let Err(e) = self.store.save(slot) {
                log::error!("could not write the state of {}: {e}", rec.id);
            }
        }
    }

    pub fn apply(&self, id: &str, event: Event) -> Option<RecordingState> {
        let mut inner = self.lock();
        let rec = inner.queue.iter_mut().find(|r| r.id == id)?;
        rec.apply(event, Utc::now());
        if let Err(e) = self.store.save(rec) {
            log::error!("could not write the state of {id}: {e}");
        }
        Some(rec.clone())
    }

    pub fn signed_out(&self) {
        let host = {
            let mut inner = self.lock();
            inner.token = None;
            inner.profile.host.clone()
        };
        if let Some(h) = host {
            let _ = keychain::delete(&h);
        }
        self.changed();
    }
}

// ---------- background loops ----------

/// Upload what is due, one recording at a time; tick the clock; poll the
/// server's status of fresh confirms. Woken by `wake` or the next retry time.
pub async fn uploader_loop(app: Arc<App>) {
    let mut last_status_poll = Instant::now() - Duration::from_secs(3600);
    loop {
        tick(&app);
        let job = {
            let inner = app.lock();
            let now = Utc::now();
            match (&inner.token, &inner.profile.host) {
                (Some(token), Some(host)) => inner
                    .queue
                    .iter()
                    .filter(|r| r.due(now) && &r.host == host)
                    .min_by_key(|r| r.started_at)
                    .map(|r| (token.clone(), r.clone())),
                _ => None,
            }
        };
        if let Some((token, mut rec)) = job {
            app.lock().uploading = Some(rec.id.clone());
            app.changed();
            let outcome = match Api::new(&rec.host) {
                Ok(api) => {
                    let path = app.store.audio_path(&rec.id);
                    let app2 = app.clone();
                    let mut changed = move |r: &RecordingState| {
                        app2.put(r);
                        app2.changed();
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

/// The clock: Warn, AskUser, and the 7-day deletion after a confirm.
fn tick(app: &Arc<App>) {
    let now = Utc::now();
    let mut delete = Vec::new();
    let mut ask = None;
    let mut any = false;
    {
        let mut inner = app.lock();
        for rec in inner.queue.iter_mut() {
            let before = rec.status;
            let out = rec.tick(now);
            if out.delete_file {
                delete.push(rec.id.clone());
            }
            if out.ask && ask.is_none() {
                ask = Some(rec.id.clone());
            }
            if rec.status != before {
                any = true;
                let _ = app.store.save(rec);
            }
        }
        if inner.ask.is_none() {
            // A question still open from before a restart comes back.
            inner.ask = ask.clone().or_else(|| {
                inner.queue.iter().find(|r| r.status == Status::AskUser).map(|r| r.id.clone())
            });
            any |= inner.ask.is_some() && ask.is_some();
        }
    }
    for id in delete {
        match app.store.delete_audio(&id) {
            Ok(()) => {
                app.apply(&id, Event::FileDeleted);
                any = true;
            }
            Err(e) => log::warn!("could not delete the audio of {id}: {e}"),
        }
    }
    if ask.is_some() {
        crate::windows::show_main(&app.handle);
    }
    if any {
        app.changed();
    }
}

async fn poll_server_status(app: &Arc<App>) {
    let (token, recent) = {
        let inner = app.lock();
        let cutoff = Utc::now() - chrono::Duration::hours(24);
        let recent: Vec<RecordingState> = inner
            .queue
            .iter()
            .filter(|r| r.status == Status::Confirmed)
            .filter(|r| r.confirmed_at.is_some_and(|at| at > cutoff))
            .filter(|r| !matches!(r.server_status.as_deref(), Some("transcribed") | Some("failed")))
            .cloned()
            .collect();
        (inner.token.clone(), recent)
    };
    let Some(token) = token else { return };
    for mut rec in recent {
        let Ok(api) = Api::new(&rec.host) else { continue };
        match uploader::refresh_server_status(&mut rec, &api, &token).await {
            Ok(true) => {
                app.put(&rec);
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

/// Meter values and the clock, ten times a second while recording.
pub async fn levels_loop(app: Arc<App>) {
    let mut ticks = 0u64;
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let payload = {
            let inner = app.lock();
            inner.active.as_ref().and_then(|a| {
                a.recording.as_ref().map(|r| {
                    let (mic, system) = r.levels.get();
                    serde_json::json!({ "mic": mic, "system": system, "elapsed_s": a.started.elapsed().as_secs() })
                })
            })
        };
        if let Some(p) = payload {
            let _ = app.handle.emit_to("main", "levels", p);
            ticks += 1;
            if ticks % 10 == 0 {
                let snap = app.snapshot();
                crate::tray::refresh(&app.handle, &snap, &app.strings());
            }
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
                inner.token = None;
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

    fn connected(&self, host: &str, token: crate::contract::RecorderToken, cancel: &AtomicBool) {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        if let Err(e) = keychain::store(host, &token.token) {
            log::error!("keychain: {e}");
            return self.connect_failed(cancel, Notice::new("recorder.connect.failed").arg("host", host_label(host)));
        }
        let ids: Vec<String> = {
            let mut inner = self.lock();
            inner.connect = None;
            inner.connect_error = None;
            inner.token = Some(token.token.clone());
            inner.online = true;
            inner.profile.host = Some(host.to_string());
            inner.profile.connection = Some(Connection {
                token_id: token.token_id,
                expires_at: token.expires_at,
                device_name: token.device_name,
                user_name: token.user.name,
                product_name: token.install.product_name,
                theme_accent: token.install.theme_accent,
                theme_primary: token.install.theme_primary,
                interface_language: token.install.interface_language,
                live_transcript_default: token.install.live_transcript_default.unwrap_or(false),
            });
            let _ = inner.profile.save(&self.data_dir);
            inner.queue.iter().map(|r| r.id.clone()).collect()
        };
        for id in ids {
            self.apply(&id, Event::Reconnected);
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
                inner.token.clone(),
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
        if let Some(h) = &host {
            keychain::delete(h).map_err(|_| "recorder.disconnect.failed".to_string())?;
        }
        {
            let mut inner = self.lock();
            inner.token = None;
            inner.profile.connection = None;
            let _ = inner.profile.save(&self.data_dir);
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
                "Meeting".to_string()
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
            let rec = RecordingState::new(id.clone(), host, title.clone(), Utc::now());
            self.store.save(&rec).map_err(|_| "recorder.error.file".to_string())?;
            inner.queue.insert(0, rec);
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
                    inner.queue.retain(|r| r.id != id);
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
            let duration = recording.finish().or_else(|e| {
                log::error!("finishing the file: {e}");
                crate::audio::ogg_opus::duration_of(&path)
            })?;
            let (sha256, size) = crate::queue::chunks::hash_file(&path)?;
            Ok::<_, std::io::Error>((duration, sha256, size))
        })
        .await
        .map_err(|_| "recorder.error.file".to_string())?;
        let result = match finished {
            Ok((duration, sha256, size)) => {
                self.apply(&id, Event::Stopped { at: Utc::now(), duration_s: duration.round() as u64, sha256, size_bytes: size });
                Ok(())
            }
            Err(e) => {
                // The file could not be read back; it stays where it is and
                // the next start finishes it.
                log::error!("the recording file: {e}");
                Err("recorder.error.file".to_string())
            }
        };
        self.lock().active = None;
        self.wake.notify_one();
        self.changed();
        result
    }

    pub fn is_busy(&self) -> bool {
        let inner = self.lock();
        inner.active.is_some() || inner.queue.iter().any(|r| r.is_unconfirmed())
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
        self.apply(id, Event::TryNow);
        self.wake.notify_one();
        self.changed();
    }

    pub fn keep_trying(&self, id: &str) {
        self.apply(id, Event::KeepTrying);
        {
            let mut inner = self.lock();
            if inner.ask.as_deref() == Some(id) {
                inner.ask = None;
            }
        }
        self.wake.notify_one();
        self.changed();
    }

    /// Copy the file to `dest`, check the copy's hash, then end the queue
    /// entry and delete the queue's own copy.
    pub fn save_elsewhere(&self, id: &str, dest: PathBuf) -> Result<(), String> {
        let rec = self.lock().queue.iter().find(|r| r.id == id).cloned().ok_or("recorder.ask.saveFailed")?;
        let src = self.store.audio_path(id);
        std::fs::copy(&src, &dest).map_err(|_| "recorder.ask.saveFailed".to_string())?;
        let (hash, _) = crate::queue::chunks::hash_file(&dest).map_err(|_| "recorder.ask.saveFailed".to_string())?;
        if Some(&hash) != rec.sha256.as_ref() {
            return Err("recorder.ask.saveFailed".into());
        }
        self.apply(id, Event::SavedElsewhere { path: dest.display().to_string() });
        let _ = self.store.delete_audio(id);
        {
            let mut inner = self.lock();
            if inner.ask.as_deref() == Some(id) {
                inner.ask = None;
            }
        }
        self.changed();
        Ok(())
    }

    /// Only a recording whose audio is gone leaves the list.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if self.store.audio_path(id).exists() {
            return Err("not removable".into());
        }
        let _ = self.store.forget(id);
        self.lock().queue.retain(|r| r.id != id);
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
            inner.live_update = None;
            inner.profile.model.clone()
        };
        let app = self.clone();
        let session = LiveSession::start(self.models_dir.clone(), model, self.live_feed.clone(), move |update| {
            app.lock().live_update = Some(update.clone());
            let _ = app.handle.emit_to("live", "live", &update);
        });
        self.lock().live = Some(session);
        crate::windows::show_live(&self.handle);
    }

    pub fn stop_live(&self) {
        let session = {
            let mut inner = self.lock();
            inner.live_update = None;
            inner.live.take()
        };
        if let Some(s) = session {
            s.stop();
        }
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

    pub fn live_state(&self) -> Option<LiveUpdate> {
        self.lock().live_update.clone()
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
                            && inner.live_update.as_ref().is_some_and(|u| u.state == "needs_model")
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
