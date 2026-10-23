//! The bearer token lives in the macOS Keychain (the Windows Credential
//! Manager in packet 10), one entry per install, through the `keyring` crate.

const SERVICE: &str = "co.mtxt.recorder";

fn entry(host: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, host).map_err(|e| e.to_string())
}

pub fn store(host: &str, token: &str) -> Result<(), String> {
    entry(host)?.set_password(token).map_err(|e| e.to_string())
}

pub fn load(host: &str) -> Option<String> {
    entry(host).ok()?.get_password().ok()
}

pub fn delete(host: &str) -> Result<(), String> {
    match entry(host)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
