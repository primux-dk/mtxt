//! mtxt Recorder: microphone and system audio, recorded to one stereo Opus
//! file, queued and uploaded to the company's own library. See
//! `apps/recorder/README.md` and docs/spec.md.

pub mod api;
pub mod app;
pub mod audio;
pub mod commands;
pub mod connect;
pub mod contract;
pub mod credentials;
pub mod keychain;
pub mod live;
pub mod locale;
pub mod permissions;
pub mod profile;
pub mod queue;
pub mod tray;
pub mod windows;

use std::sync::Arc;
use tauri::{Manager, WindowEvent};

impl queue::Status {
    /// Still on this computer and not yet in the library.
    pub fn is_waiting(self) -> bool {
        matches!(self, queue::Status::Uploading | queue::Status::Pending | queue::Status::Warn | queue::Status::AskUser)
    }
}

/// The bundle identifier, which names the data directory on both platforms.
pub const IDENTIFIER: &str = "co.mtxt.recorder";

/// The log goes to stderr on macOS. A Windows release build has no console,
/// so there it goes to `%LOCALAPPDATA%\co.mtxt.recorder\logs\recorder.log`,
/// the previous run's kept as `recorder.previous.log`.
fn init_log() {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut builder =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,whisper_rs=warn,ort=warn"));
    #[cfg(target_os = "windows")]
    if let Some(file) = std::env::var_os("LOCALAPPDATA").and_then(|d| log_file(std::path::Path::new(&d))) {
        builder.target(env_logger::Target::Pipe(Box::new(file)));
    }
    builder.init();
}

/// Open a fresh log under `local`, keeping the last one beside it.
pub fn log_file(local: &std::path::Path) -> Option<std::fs::File> {
    let dir = local.join(IDENTIFIER).join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("recorder.log");
    let _ = std::fs::rename(&path, dir.join("recorder.previous.log"));
    std::fs::File::create(path).ok()
}

pub fn run() {
    init_log();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::set_host,
            commands::start_connect,
            commands::reopen_connect,
            commands::cancel_connect,
            commands::disconnect,
            commands::request_permissions,
            commands::refresh,
            commands::open_settings,
            commands::start_recording,
            commands::stop_recording,
            commands::try_now,
            commands::keep_trying,
            commands::save_elsewhere,
            commands::remove_recording,
            commands::claim,
            commands::export_audio,
            commands::delete_local,
            commands::review,
            commands::retry_unreadable,
            commands::retry_damaged,
            commands::retry_save,
            commands::open_url,
            commands::set_live,
            commands::show_live,
            commands::hide_live,
            commands::pause_live,
            commands::live_state,
            commands::set_model,
            commands::download_model,
            commands::dismiss_notice,
        ])
        .setup(|tauri_app| {
            let handle = tauri_app.handle().clone();
            // The local, not the roaming, application data: on Windows a roaming
            // profile would copy every recording and model to the domain server.
            // On macOS both are ~/Library/Application Support.
            let data_dir = handle.path().app_local_data_dir()?;
            let app = app::App::new(handle.clone(), data_dir)?;
            handle.manage(app.clone());
            tray::build(&handle)?;
            let snap = app.snapshot();
            windows::create(&handle, &snap)?;
            tray::refresh(&handle, &snap, &app.strings());
            tauri::async_runtime::spawn(app::uploader_loop(app.clone()));
            tauri::async_runtime::spawn(app::levels_loop(app.clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let handle = window.app_handle();
                let app = handle.state::<Arc<app::App>>().inner().clone();
                match window.label() {
                    "main" => {
                        if app.is_busy() {
                            api.prevent_close();
                            windows::hide_main(handle);
                        } else {
                            handle.exit(0);
                        }
                    }
                    "live" => {
                        api.prevent_close();
                        app.hide_live();
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the recorder");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            windows::show_main(handle);
        }
        let _ = (handle, &event);
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_log_keeps_one_previous_run() {
        use std::io::Write;
        let local = tempfile::tempdir().unwrap();
        writeln!(super::log_file(local.path()).unwrap(), "first").unwrap();
        writeln!(super::log_file(local.path()).unwrap(), "second").unwrap();
        let dir = local.path().join("co.mtxt.recorder").join("logs");
        assert_eq!(std::fs::read_to_string(dir.join("recorder.log")).unwrap(), "second\n");
        assert_eq!(std::fs::read_to_string(dir.join("recorder.previous.log")).unwrap(), "first\n");
    }
}
