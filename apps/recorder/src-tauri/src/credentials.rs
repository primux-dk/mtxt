//! The connection's credential: the bearer token, bound to the install, the
//! user and the token id it was issued for.
//!
//! The binding (host, user id, address, token id) lives in `settings.json`;
//! the token lives in the Keychain together with its token id. Connecting
//! writes the binding first, atomically, and only then the Keychain. On start
//! the token is used only when its token id is the binding's; any mismatch
//! (a write that failed half-way, a Keychain from another connection) means
//! disconnected, and nothing is uploaded.

use crate::contract::RecorderToken;
use crate::profile::{Connection, Profile};
use serde::{Deserialize, Serialize};

/// Where the secret goes: the Keychain, or a test double.
pub trait SecretStore: Send + Sync {
    fn set(&self, host: &str, value: &str) -> Result<(), String>;
    fn get(&self, host: &str) -> Option<String>;
    fn delete(&self, host: &str) -> Result<(), String>;
}

pub struct Keychain;

impl SecretStore for Keychain {
    fn set(&self, host: &str, value: &str) -> Result<(), String> {
        crate::keychain::store(host, value)
    }
    fn get(&self, host: &str) -> Option<String> {
        crate::keychain::load(host)
    }
    fn delete(&self, host: &str) -> Result<(), String> {
        crate::keychain::delete(host)
    }
}

/// What the Keychain entry holds.
#[derive(Serialize, Deserialize)]
struct Secret {
    token_id: String,
    token: String,
}

#[derive(Clone, PartialEq)]
pub struct Credential {
    pub token: String,
    pub token_id: String,
}

impl std::fmt::Debug for Credential {
    // The token never reaches a log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential").field("token_id", &self.token_id).finish_non_exhaustive()
    }
}

/// On start: the Keychain token for the profile's install, only when its
/// token id is the profile's. An entry in the old plain-token form, or any
/// other mismatch, is no credential.
pub fn restore(profile: &Profile, store: &dyn SecretStore) -> Option<Credential> {
    let host = profile.host.as_deref()?;
    let binding = profile.connection.as_ref()?;
    let secret: Secret = serde_json::from_str(&store.get(host)?).ok()?;
    if secret.token_id != binding.token_id || binding.user_id.is_empty() {
        log::warn!("the Keychain token does not belong to this connection; disconnected");
        return None;
    }
    Some(Credential { token: secret.token, token_id: secret.token_id })
}

#[derive(Debug, PartialEq)]
pub enum BindError {
    /// The binding could not be written: nothing changed, the old connection stands.
    Profile(String),
    /// The binding was written but the Keychain refused the token: disconnected.
    Keychain(String),
}

/// On connect: write the new binding, then the token. A failed profile write
/// leaves the profile and the Keychain as they were.
pub fn bind(
    profile: &mut Profile,
    save: &dyn Fn(&Profile) -> std::io::Result<()>,
    store: &dyn SecretStore,
    host: &str,
    token: &RecorderToken,
) -> Result<Credential, BindError> {
    let mut next = profile.clone();
    next.host = Some(host.to_string());
    next.connection = Some(Connection {
        token_id: token.token_id.clone(),
        expires_at: token.expires_at.clone(),
        device_name: token.device_name.clone(),
        user_id: token.user.id.clone(),
        user_email: token.user.email.clone(),
        user_name: token.user.name.clone(),
        product_name: token.install.product_name.clone(),
        theme_accent: token.install.theme_accent.clone(),
        theme_primary: token.install.theme_primary.clone(),
        interface_language: token.install.interface_language.clone(),
        live_transcript_default: token.install.live_transcript_default.unwrap_or(false),
    });
    save(&next).map_err(|e| BindError::Profile(e.to_string()))?;
    *profile = next;
    let secret = serde_json::to_string(&Secret { token_id: token.token_id.clone(), token: token.token.clone() })
        .expect("a secret serialises");
    store.set(host, &secret).map_err(BindError::Keychain)?;
    Ok(Credential { token: token.token.clone(), token_id: token.token_id.clone() })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::contract::{RecorderInstall, RecorderUser};
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemoryStore(pub Mutex<HashMap<String, String>>);
    impl SecretStore for MemoryStore {
        fn set(&self, host: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(host.into(), value.into());
            Ok(())
        }
        fn get(&self, host: &str) -> Option<String> {
            self.0.lock().unwrap().get(host).cloned()
        }
        fn delete(&self, host: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(host);
            Ok(())
        }
    }

    pub fn token(who: &str) -> RecorderToken {
        RecorderToken {
            token: format!("mtxt_secret-{who}"),
            token_id: format!("tok-{who}"),
            expires_at: "2027-04-21T00:00:00Z".into(),
            device_name: "Mac".into(),
            user: RecorderUser { id: format!("user-{who}"), name: who.into(), email: format!("{who}@example.com") },
            install: RecorderInstall {
                product_name: "P".into(),
                theme_accent: "#566b45".into(),
                theme_primary: "#111111".into(),
                interface_language: None,
                live_transcript_default: None,
            },
        }
    }

    #[test]
    fn a_failed_profile_write_keeps_the_old_binding_and_the_old_token() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let mut p = Profile::load(tmp.path());
        let ok = |p: &Profile| p.save(tmp.path());
        bind(&mut p, &ok, &store, "https://a.example", &token("a")).unwrap();
        let fail = |_: &Profile| Err(std::io::Error::from_raw_os_error(28));
        assert!(matches!(bind(&mut p, &fail, &store, "https://a.example", &token("b")), Err(BindError::Profile(_))));
        assert_eq!(p.connection.as_ref().unwrap().user_id, "user-a");
        // After a restart: A's binding and A's token, nothing of B.
        let again = Profile::load(tmp.path());
        let c = restore(&again, &store).unwrap();
        assert_eq!(c.token, "mtxt_secret-a");
        assert!(!format!("{c:?}").contains("secret"));
    }

    #[test]
    fn a_keychain_that_disagrees_with_the_binding_means_disconnected() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let mut p = Profile::load(tmp.path());
        let ok = |p: &Profile| p.save(tmp.path());
        bind(&mut p, &ok, &store, "https://a.example", &token("a")).unwrap();
        // B's binding is written, then the Keychain refuses B's token.
        struct Refuses<'a>(&'a MemoryStore);
        impl SecretStore for Refuses<'_> {
            fn set(&self, _: &str, _: &str) -> Result<(), String> {
                Err("refused".into())
            }
            fn get(&self, h: &str) -> Option<String> {
                self.0.get(h)
            }
            fn delete(&self, h: &str) -> Result<(), String> {
                self.0.delete(h)
            }
        }
        assert!(matches!(bind(&mut p, &ok, &Refuses(&store), "https://a.example", &token("b")), Err(BindError::Keychain(_))));
        assert!(restore(&Profile::load(tmp.path()), &store).is_none(), "A's token must not serve B's binding");
        // The old plain-token form is no credential either.
        store.set("https://a.example", "mtxt_plain").unwrap();
        assert!(restore(&Profile::load(tmp.path()), &store).is_none());
    }
}
