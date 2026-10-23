//! The menu bar item on macOS, the notification area icon on Windows: the
//! product name, what the recorder is doing, Open, Stop recording, Disconnect,
//! About and Quit.

use crate::app::{App, Snapshot};
use crate::locale::Strings;
use serde_json::json;
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

pub struct TrayItems {
    product: MenuItem<Wry>,
    status: MenuItem<Wry>,
    open: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    disconnect: MenuItem<Wry>,
    about: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

// macOS: a template glyph the menu bar tints. Windows: the app tile, which
// reads on a light and a dark taskbar, with a red dot while recording.
#[cfg(target_os = "macos")]
const ICON: &[u8] = include_bytes!("../icons/tray@2x.png");
#[cfg(target_os = "macos")]
const ICON_RECORDING: &[u8] = include_bytes!("../icons/tray-recording@2x.png");
#[cfg(not(target_os = "macos"))]
const ICON: &[u8] = include_bytes!("../icons/tray-windows.png");
#[cfg(not(target_os = "macos"))]
const ICON_RECORDING: &[u8] = include_bytes!("../icons/tray-windows-recording.png");
/// Only macOS tints a template icon.
const TEMPLATE: bool = cfg!(target_os = "macos");

pub fn build(handle: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, enabled: bool| MenuItem::with_id(handle, id, id, enabled, None::<&str>);
    let items = TrayItems {
        product: item("product", false)?,
        status: item("status", false)?,
        open: item("open", true)?,
        stop: item("stop", false)?,
        disconnect: item("disconnect", false)?,
        about: item("about", true)?,
        quit: item("quit", true)?,
    };
    let sep = || PredefinedMenuItem::separator(handle);
    let menu = Menu::with_items(
        handle,
        &[
            &items.product,
            &items.status,
            &sep()?,
            &items.open,
            &items.stop,
            &sep()?,
            &items.disconnect,
            &items.about,
            &items.quit,
        ],
    )?;
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(ICON)?)
        .icon_as_template(TEMPLATE)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu)
        .build(handle)?;
    handle.manage(items);
    Ok(())
}

fn on_menu(handle: &AppHandle, event: MenuEvent) {
    let app = handle.state::<Arc<App>>().inner().clone();
    match event.id().as_ref() {
        "open" => crate::windows::show_main(handle),
        "stop" => {
            tauri::async_runtime::spawn(async move {
                let _ = app.stop_recording().await;
            });
        }
        "disconnect" => {
            crate::windows::show_main(handle);
            let _ = handle.emit_to("main", "confirm-disconnect", ());
        }
        "about" => crate::windows::about(handle, &app),
        "quit" => {
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                // A recording in progress is finished and kept, then the app ends.
                let _ = app.stop_recording().await;
                handle.exit(0);
            });
        }
        _ => {}
    }
}

fn clock(secs: u64) -> String {
    format!("{:02}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60)
}

pub fn refresh(handle: &AppHandle, snap: &Snapshot, s: &Strings) {
    let Some(items) = handle.try_state::<TrayItems>() else { return };
    let product = snap.connection.as_ref().map(|c| c.product_name.clone()).unwrap_or_else(|| "mtxt Recorder".into());
    let p = json!(product);
    let status = if let Some(r) = &snap.recording {
        s.get("menu.status.recording", &[("time", json!(clock(r.elapsed_s)))])
    } else if let Some(q) = snap.queue.iter().find(|q| q.active) {
        s.get("menu.status.uploading", &[("done", json!(q.done)), ("total", json!(q.total))])
    } else {
        let waiting = snap.queue.iter().filter(|q| q.status.is_waiting()).count();
        if waiting > 0 {
            s.get("menu.status.waiting", &[("count", json!(waiting))])
        } else {
            s.get("menu.status.ready", &[])
        }
    };
    let _ = items.product.set_text(&product);
    let _ = items.status.set_text(status);
    let _ = items.open.set_text(s.get("menu.open", &[("product", p.clone())]));
    let _ = items.stop.set_text(s.get("menu.stop", &[]));
    let _ = items.stop.set_enabled(snap.recording.as_ref().is_some_and(|r| !r.starting && !r.stopping));
    let _ = items.disconnect.set_text(s.get("menu.disconnect", &[]));
    let _ = items.disconnect.set_enabled(snap.connection.is_some() && !snap.signed_out);
    let _ = items.about.set_text(s.get("menu.about", &[]));
    let _ = items.quit.set_text(s.get("menu.quit", &[("product", p)]));
    if let Some(tray) = handle.tray_by_id("main") {
        let bytes = if snap.recording.is_some() { ICON_RECORDING } else { ICON };
        if let Ok(img) = Image::from_bytes(bytes) {
            let _ = tray.set_icon(Some(img));
            let _ = tray.set_icon_as_template(TEMPLATE);
        }
        let _ = tray.set_tooltip(Some(&product));
    }
}
