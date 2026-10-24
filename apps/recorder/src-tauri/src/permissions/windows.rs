//! Windows: the microphone follows the switches under Settings → Privacy &
//! security → Microphone, which Windows keeps in the capability consent store
//! in the registry: the device-wide switch (HKLM), the user's switch for
//! packaged (Store) apps (HKCU), and "Let desktop apps access your microphone"
//! (HKCU, `NonPackaged`). The recorder is a desktop app, so the device-wide
//! switch and the desktop switch decide; the packaged-app value counts only
//! when the desktop one is missing. Privacy tools set the packaged-app value
//! to `Deny` while desktop apps keep the microphone, and a rule that read any
//! `Deny` as a refusal kept the recorder from a microphone Windows allows.
//! Windows does not ask a desktop app first, so there is no NotDetermined.
//!
//! Loopback capture of the output device needs no permission: system audio is
//! Granted whenever a WASAPI output device exists, and `capture::windows`
//! reports a missing one as NoDevice.

use super::Permission;

/// The device-wide, packaged-app and desktop-app values. A missing value
/// counts as Allow: a fresh Windows install writes them only when a switch is
/// touched. Values other than `Allow` and `Deny` count as missing.
pub fn from_consent(device: Option<&str>, packaged: Option<&str>, desktop: Option<&str>) -> Permission {
    let deny = |v: Option<&str>| v.is_some_and(|v| v.eq_ignore_ascii_case("deny"));
    let allow = |v: Option<&str>| v.is_some_and(|v| v.eq_ignore_ascii_case("allow"));
    if deny(device) || deny(desktop) {
        Permission::Denied
    } else if allow(desktop) {
        Permission::Granted
    } else if deny(packaged) {
        Permission::Denied
    } else {
        Permission::Granted
    }
}

#[cfg(target_os = "windows")]
mod registry {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    /// A REG_SZ `Value` under `key`, or None when it is not there.
    fn value(root: HKEY, key: &str) -> Option<String> {
        let key = HSTRING::from(key);
        let name = HSTRING::from("Value");
        let mut buf = [0u16; 64];
        let mut size = std::mem::size_of_val(&buf) as u32;
        let status = unsafe {
            RegGetValueW(
                root,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if status.is_err() {
            return None;
        }
        let len = (size as usize / 2).min(buf.len());
        let text = String::from_utf16_lossy(&buf[..len]);
        Some(text.trim_end_matches('\0').to_string())
    }

    pub fn microphone_consent() -> [Option<String>; 3] {
        [
            value(HKEY_LOCAL_MACHINE, STORE),
            value(HKEY_CURRENT_USER, STORE),
            value(HKEY_CURRENT_USER, &format!(r"{STORE}\NonPackaged")),
        ]
    }
}

#[cfg(target_os = "windows")]
pub fn microphone() -> Permission {
    let [device, packaged, desktop] = registry::microphone_consent();
    from_consent(device.as_deref(), packaged.as_deref(), desktop.as_deref())
}

/// Windows shows no prompt to a desktop app: asking is reading the switches.
#[cfg(target_os = "windows")]
pub fn request_microphone() -> Permission {
    microphone()
}

#[cfg(target_os = "windows")]
pub fn system_audio() -> Permission {
    Permission::Granted
}

#[cfg(target_os = "windows")]
pub fn request_system_audio() -> Permission {
    Permission::Granted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_device_and_desktop_switches_decide() {
        let (a, d) = (Some("Allow"), Some("Deny"));
        assert_eq!(from_consent(None, None, None), Permission::Granted);
        assert_eq!(from_consent(a, a, a), Permission::Granted);
        // The device-wide switch off: nothing records.
        assert_eq!(from_consent(d, a, a), Permission::Denied);
        // Desktop apps off.
        assert_eq!(from_consent(a, a, d), Permission::Denied);
        assert_eq!(from_consent(None, None, Some("deny")), Permission::Denied);
        // A privacy tool turned packaged apps off; desktop apps are still allowed.
        assert_eq!(from_consent(a, d, a), Permission::Granted);
        // No desktop value at all: the packaged-app value is all there is.
        assert_eq!(from_consent(a, d, None), Permission::Denied);
        // An unknown value is not a refusal.
        assert_eq!(from_consent(Some("Prompt"), None, None), Permission::Granted);
    }
}
