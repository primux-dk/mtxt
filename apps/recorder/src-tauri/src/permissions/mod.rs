//! The two permissions a recording needs, per platform.
//!
//! macOS (`macos`): the microphone, and the audio capture permission macOS
//! 14.2 and later asks for before a process tap delivers anything but silence.
//! The window explains each one before macOS asks (behaviour rule 9), and
//! shows a button to System Settings when denied.
//!
//! Windows (`windows`): the microphone follows the privacy switches in
//! Settings, which Windows does not ask about for a desktop app; loopback
//! capture of the output device needs no permission. A denied microphone shows
//! a button to the Settings page.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Granted,
    Denied,
    /// The operating system has not asked yet (macOS only).
    NotDetermined,
    /// This system cannot tell, or has no such capture (macOS before 14.2).
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Permissions {
    pub microphone: Permission,
    pub system_audio: Permission,
}

pub fn current() -> Permissions {
    Permissions { microphone: microphone(), system_audio: system_audio() }
}

#[cfg(target_os = "macos")]
pub mod macos;
// Compiled everywhere, so its consent rules are tested on every platform;
// the registry reads inside are Windows only.
pub mod windows;

#[cfg(target_os = "macos")]
pub use macos::{microphone, request_microphone, request_system_audio, system_audio};
#[cfg(target_os = "windows")]
pub use windows::{microphone, request_microphone, request_system_audio, system_audio};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn microphone() -> Permission {
    Permission::Granted
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn request_microphone() -> Permission {
    Permission::Granted
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn system_audio() -> Permission {
    Permission::Unsupported
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn request_system_audio() -> Permission {
    Permission::Unsupported
}

/// The settings page for a permission on this platform.
pub fn settings_url(which: &str) -> Option<&'static str> {
    settings_url_for(std::env::consts::OS, which)
}

pub fn settings_url_for(os: &str, which: &str) -> Option<&'static str> {
    match (os, which) {
        ("macos", "microphone") => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
        ("macos", "system_audio") => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"),
        // Settings → Privacy & security → Microphone. Windows has no switch for
        // loopback capture; the sound settings are where output devices live.
        ("windows", "microphone") => Some("ms-settings:privacy-microphone"),
        ("windows", "system_audio") => Some("ms-settings:sound"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_platform_opens_its_own_settings() {
        assert!(settings_url_for("macos", "microphone").unwrap().starts_with("x-apple.systempreferences:"));
        assert_eq!(settings_url_for("windows", "microphone"), Some("ms-settings:privacy-microphone"));
        assert_eq!(settings_url_for("windows", "camera"), None);
        assert_eq!(settings_url_for("linux", "microphone"), None);
    }
}
