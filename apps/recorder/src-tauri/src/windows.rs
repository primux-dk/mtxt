//! The two native windows. Main: 360 × 520, the native title bar, hides to
//! the menu bar on close while a recording or an upload is in progress. Live:
//! 420 × 200, a utility panel always on top, its own drag area, no traffic
//! lights; Hide returns it to the menu bar and the recording goes on.

use crate::app::{App, Snapshot};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn create(handle: &AppHandle, snap: &Snapshot) -> tauri::Result<()> {
    let title = snap.connection.as_ref().map(|c| c.product_name.clone()).unwrap_or_else(|| "mtxt Recorder".into());
    WebviewWindowBuilder::new(handle, "main", WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(360.0, 520.0)
        .min_inner_size(320.0, 440.0)
        .resizable(true)
        .visible(true)
        .build()?;
    #[allow(unused_mut)]
    let mut live = WebviewWindowBuilder::new(handle, "live", WebviewUrl::App("live.html".into()))
        .title("Live")
        .inner_size(420.0, 200.0)
        .min_inner_size(300.0, 140.0)
        .resizable(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false);
    #[cfg(target_os = "macos")]
    {
        live = live.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    let live = live.build()?;
    #[cfg(target_os = "macos")]
    mac::make_panel(&live);
    #[cfg(not(target_os = "macos"))]
    let _ = live;
    Ok(())
}

pub fn show_main(handle: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = handle.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn hide_main(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.hide();
    }
    // Hidden to the menu bar: no Dock icon until the window opens again.
    #[cfg(target_os = "macos")]
    let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

pub fn show_live(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("live") {
        let _ = w.show();
    }
}

pub fn hide_live(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("live") {
        let _ = w.hide();
    }
}

/// The window titles follow the install's product name.
pub fn apply_branding(handle: &AppHandle, snap: &Snapshot) {
    if let (Some(w), Some(c)) = (handle.get_webview_window("main"), snap.connection.as_ref()) {
        let _ = w.set_title(&c.product_name);
    }
}

pub fn about(handle: &AppHandle, app: &Arc<App>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let snap = app.snapshot();
    let product = snap.connection.as_ref().map(|c| c.product_name.clone()).unwrap_or_else(|| "mtxt Recorder".into());
    let s = app.strings();
    let body = s.get(
        "about.body",
        &[("product", serde_json::json!(product)), ("version", serde_json::json!(env!("CARGO_PKG_VERSION")))],
    );
    handle.dialog().message(body).title(s.get("menu.about", &[])).kind(MessageDialogKind::Info).show(|_| {});
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowCollectionBehavior};

    /// No traffic lights on the live panel, and it floats over a meeting in
    /// full screen. Called from `setup`, on the main thread.
    pub fn make_panel(window: &tauri::WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        unsafe {
            let ns: &NSWindow = &*(ptr as *const NSWindow);
            for b in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
                if let Some(button) = ns.standardWindowButton(b) {
                    button.setHidden(true);
                }
            }
            ns.setCollectionBehavior(
                ns.collectionBehavior()
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::CanJoinAllSpaces,
            );
        }
    }
}
