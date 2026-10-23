//! What the windows may ask the recorder to do. Each returns quickly; slow
//! work runs on the async runtime or its own thread, and the result arrives
//! as a new snapshot.

use crate::app::{App, Snapshot};
use crate::live::LiveTranscript;
use crate::permissions::Permissions;
use std::sync::Arc;
use tauri::State;

type AppState<'a> = State<'a, Arc<App>>;

#[tauri::command]
pub fn snapshot(app: AppState) -> Snapshot {
    app.snapshot()
}

#[tauri::command]
pub fn set_host(app: AppState, input: String) -> Result<String, String> {
    app.set_host(&input)
}

#[tauri::command]
pub fn start_connect(app: AppState) -> Result<String, String> {
    app.start_connect()
}

#[tauri::command]
pub fn reopen_connect(app: AppState) {
    app.reopen_connect()
}

#[tauri::command]
pub fn cancel_connect(app: AppState) {
    app.cancel_connect()
}

#[tauri::command]
pub async fn disconnect(app: AppState<'_>, local_only: bool) -> Result<(), String> {
    app.disconnect(local_only).await
}

#[tauri::command]
pub async fn request_permissions(app: AppState<'_>) -> Result<Permissions, String> {
    let app = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || app.request_permissions()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn refresh(app: AppState) {
    app.changed()
}

#[tauri::command]
pub fn open_settings(app: AppState, which: String) {
    if let Some(url) = crate::permissions::settings_url(&which) {
        crate::app::open_url(&app.handle, url);
    }
}

#[tauri::command]
pub async fn start_recording(app: AppState<'_>, title: String) -> Result<(), String> {
    app.start_recording(title).await
}

#[tauri::command]
pub async fn stop_recording(app: AppState<'_>) -> Result<(), String> {
    app.stop_recording().await
}

#[tauri::command]
pub fn try_now(app: AppState, id: String) {
    app.try_now(&id)
}

#[tauri::command]
pub fn keep_trying(app: AppState, id: String) {
    app.keep_trying(&id)
}

/// The save dialog, then the export. `damaged` saves a damaged entry's audio.
#[tauri::command]
pub async fn save_elsewhere(app: AppState<'_>, id: String, title: String, dialog_title: String, damaged: Option<bool>) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let safe: String = title.chars().map(|c| if "/\\:*?\"<>|".contains(c) { '-' } else { c }).collect();
    let name = format!("{}.ogg", safe.trim().chars().take(100).collect::<String>());
    let handle = app.handle.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle.dialog().file().set_title(dialog_title).set_file_name(name).add_filter("Ogg Opus", &["ogg"]).blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(false) };
    let app = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if damaged == Some(true) {
            app.save_damaged_elsewhere(&id, path)
        } else {
            app.save_elsewhere(&id, path)
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(true)
}

#[tauri::command]
pub fn claim(app: AppState, id: String) -> Result<(), String> {
    app.claim(&id)
}

#[tauri::command]
pub fn review(app: AppState, id: String) -> Result<(), String> {
    app.review(&id)
}

#[tauri::command]
pub fn retry_unreadable(app: AppState, id: String) {
    app.retry_unreadable(&id)
}

#[tauri::command]
pub fn retry_damaged(app: AppState, id: String) {
    app.retry_damaged(&id)
}

#[tauri::command]
pub fn retry_save(app: AppState) {
    app.retry_save()
}

#[tauri::command]
pub fn remove_recording(app: AppState, id: String) -> Result<(), String> {
    app.remove(&id)
}

#[tauri::command]
pub fn open_url(app: AppState, url: String) {
    // Only the install's own pages.
    let host = app.lock().profile.host.clone();
    if host.is_some_and(|h| url.starts_with(&format!("{h}/"))) {
        crate::app::open_url(&app.handle, &url);
    }
}

#[tauri::command]
pub fn set_live(app: AppState, enabled: bool) {
    app.set_live(enabled)
}

#[tauri::command]
pub fn show_live(app: AppState) {
    app.show_live()
}

#[tauri::command]
pub fn hide_live(app: AppState) {
    app.hide_live()
}

#[tauri::command]
pub fn pause_live(app: AppState, paused: bool) {
    app.pause_live(paused)
}

#[tauri::command]
pub fn live_state(app: AppState) -> LiveTranscript {
    app.live_state()
}

#[tauri::command]
pub fn set_model(app: AppState, id: String) {
    app.set_model(&id)
}

#[tauri::command]
pub fn download_model(app: AppState, id: String) {
    app.download_model(&id)
}

#[tauri::command]
pub fn dismiss_notice(app: AppState) {
    app.set_notice(None)
}
