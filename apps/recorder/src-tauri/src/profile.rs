//! `settings.json` in the app's data directory: which install the recorder
//! belongs to, the branding the token response carried, and the user's own
//! choices. The token itself is in the keychain, never here.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Profile {
    /// The install's origin, `https://meetings.acme.com`.
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub connection: Option<Connection>,
    /// The user's own live transcript switch; None follows the admin default.
    #[serde(default)]
    pub live_transcript: Option<bool>,
    /// `parakeet` or `whisper`.
    #[serde(default = "default_model")]
    pub model: String,
    /// The permission explanation was shown and macOS asked.
    #[serde(default)]
    pub permissions_asked: bool,
}

fn default_model() -> String {
    "parakeet".into()
}

/// What the token response said, minus the token.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Connection {
    pub token_id: String,
    pub expires_at: String,
    pub device_name: String,
    /// The library user's id and address: the owner of what this connection records.
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub user_email: String,
    pub user_name: String,
    pub product_name: String,
    pub theme_accent: String,
    pub theme_primary: String,
    #[serde(default)]
    pub interface_language: Option<String>,
    #[serde(default)]
    pub live_transcript_default: bool,
}

impl Profile {
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join("settings.json")
    }

    pub fn load(data_dir: &Path) -> Profile {
        std::fs::read(Self::path(data_dir))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| Profile { model: default_model(), ..Default::default() })
    }

    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        let path = Self::path(data_dir);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)?;
        std::fs::rename(tmp, path)
    }

    pub fn live_enabled(&self) -> bool {
        self.live_transcript
            .unwrap_or_else(|| self.connection.as_ref().map(|c| c.live_transcript_default).unwrap_or(false))
    }

    /// The owner a new recording gets: the connected user.
    pub fn owner(&self) -> Option<crate::queue::state::Owner> {
        let c = self.connection.as_ref()?;
        (!c.user_id.is_empty())
            .then(|| crate::queue::state::Owner { user_id: c.user_id.clone(), email: c.user_email.clone() })
    }

    pub fn product_name(&self) -> String {
        self.connection.as_ref().map(|c| c.product_name.clone()).unwrap_or_else(|| "mtxt Recorder".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(default_on: bool) -> Connection {
        Connection {
            token_id: "t".into(),
            expires_at: "2027-04-21T00:00:00Z".into(),
            device_name: "Mac".into(),
            user_id: "u1".into(),
            user_email: "mette.lund@example.com".into(),
            user_name: "Mette Lund".into(),
            product_name: "Primux Møder".into(),
            theme_accent: "#566b45".into(),
            theme_primary: "#111111".into(),
            interface_language: Some("da".into()),
            live_transcript_default: default_on,
        }
    }

    #[test]
    fn live_follows_the_admin_default_until_the_user_chooses() {
        let mut p = Profile::default();
        assert!(!p.live_enabled());
        p.connection = Some(connection(true));
        assert!(p.live_enabled());
        p.live_transcript = Some(false);
        assert!(!p.live_enabled());
    }

    #[test]
    fn round_trips_and_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Profile::load(tmp.path());
        assert_eq!(p.model, "parakeet");
        assert_eq!(p.product_name(), "mtxt Recorder");
        let mut p = p;
        p.host = Some("https://app.mtxt.co".into());
        p.connection = Some(connection(false));
        p.save(tmp.path()).unwrap();
        let back = Profile::load(tmp.path());
        assert_eq!(back, p);
        assert!(!std::fs::read_to_string(Profile::path(tmp.path())).unwrap().contains("mtxt_"));
    }
}
