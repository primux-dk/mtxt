//! Windows: the microphone follows three switches under Settings → Privacy &
//! security → Microphone, which Windows keeps in the capability consent store
//! in the registry. Any one of them set to `Deny` keeps a desktop app from the
//! microphone: the device-wide switch (HKLM), the user's "Microphone access",
//! and "Let desktop apps access your microphone" (HKCU, `NonPackaged`).
//! Windows does not ask a desktop app first, so there is no NotDetermined.
//!
//! Loopback capture of the output device needs no permission: system audio is
//! Granted whenever a WASAPI output device exists, and `capture::windows`
//! reports a missing one as NoDevice.

use super::Permission;

/// The three consent values, most general first. Missing keys count as Allow:
/// a fresh Windows install writes them only when a switch is touched.
pub fn from_consent(values: &[Option<&str>]) -> Permission {
    if values.iter().any(|v| v.is_some_and(|v| v.eq_ignore_ascii_case("deny"))) {
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
    let values = registry::microphone_consent();
    let refs: Vec<Option<&str>> = values.iter().map(|v| v.as_deref()).collect();
    from_consent(&refs)
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
    fn any_deny_keeps_the_microphone_closed() {
        assert_eq!(from_consent(&[None, None, None]), Permission::Granted);
        assert_eq!(from_consent(&[Some("Allow"), Some("Allow"), Some("Allow")]), Permission::Granted);
        assert_eq!(from_consent(&[Some("Allow"), None, Some("Deny")]), Permission::Denied);
        assert_eq!(from_consent(&[Some("Deny"), Some("Allow"), None]), Permission::Denied);
        assert_eq!(from_consent(&[None, Some("deny"), None]), Permission::Denied);
        // An unknown value is not a refusal.
        assert_eq!(from_consent(&[Some("Prompt"), None, None]), Permission::Granted);
    }
}
