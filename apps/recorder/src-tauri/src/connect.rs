//! Connecting the recorder to an install, per docs/spec.md "Recorder connection"
//! and `x-recorder-flow` in the contract: the verifier and its challenge, the
//! pairing code, the device name, the hostname and the `/connect` URL.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};

/// The verifier stays in memory; only the challenge leaves the recorder before the poll.
#[derive(Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl std::fmt::Debug for Pkce {
    // The verifier never reaches a log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pkce").field("challenge", &self.challenge).finish_non_exhaustive()
    }
}

impl Pkce {
    /// 32 random bytes from the OS, base64url without padding (43 characters).
    pub fn generate() -> Pkce {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("the OS random source");
        Pkce::from_verifier(URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn from_verifier(verifier: String) -> Pkce {
        let challenge = challenge_for(&verifier);
        Pkce { verifier, challenge }
    }
}

/// RFC 7636 S256: base64url without padding of SHA-256 of the verifier's ASCII bytes.
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The six-character code both the recorder and the connect page show, `XXX-XXX`.
pub fn pairing_code(challenge: &str) -> String {
    let digest = Sha256::digest(challenge.as_bytes());
    let bits = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) >> 2;
    let mut code = String::with_capacity(7);
    for i in 0..6 {
        let group = (bits >> (25 - 5 * i)) & 0x1f;
        if i == 3 {
            code.push('-');
        }
        code.push(CROCKFORD[group as usize] as char);
    }
    code
}

fn prohibited(c: char) -> bool {
    matches!(
        c.general_category(),
        GeneralCategory::Control
            | GeneralCategory::Format
            | GeneralCategory::LineSeparator
            | GeneralCategory::ParagraphSeparator
    )
}

/// The computer's name made safe for the server: prohibited categories out,
/// NFC, trimmed, at most 64 code points, trimmed again; empty becomes "Recorder".
pub fn device_name(raw: &str) -> String {
    let kept: String = raw.chars().filter(|c| !prohibited(*c)).collect();
    let normalised: String = kept.nfc().collect();
    let truncated: String = normalised.trim().chars().take(64).collect();
    let name = truncated.trim();
    if name.is_empty() {
        "Recorder".to_string()
    } else {
        name.to_string()
    }
}

/// RFC 3986 unreserved characters stay; everything else is percent-encoded.
const QUERY_VALUE: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// The install's origin, from what the user typed: `meetings.acme.com`,
/// `https://meetings.acme.com/` or a pasted link into the library. Plain http
/// is accepted only for this machine (a `wrangler dev` install).
pub fn normalise_host(input: &str) -> Result<String, HostError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(HostError::Empty);
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else if is_local(trimmed) {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| HostError::Invalid)?;
    let host = url.host_str().ok_or(HostError::Invalid)?;
    if !host.contains('.') && !is_local(host) {
        return Err(HostError::Invalid);
    }
    match url.scheme() {
        "https" => {}
        "http" if is_local(host) => {}
        "http" => return Err(HostError::NotHttps),
        _ => return Err(HostError::Invalid),
    }
    let mut origin = format!("{}://{}", url.scheme(), host);
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

fn is_local(host: &str) -> bool {
    let name = host.split(':').next().unwrap_or(host);
    name == "localhost" || name == "127.0.0.1" || name == "[::1]"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HostError {
    #[error("empty")]
    Empty,
    #[error("invalid")]
    Invalid,
    #[error("not_https")]
    NotHttps,
}

impl HostError {
    /// The locale key the window shows at the field.
    pub fn key(self) -> &'static str {
        match self {
            HostError::Empty => "recorder.connect.host.empty",
            HostError::Invalid => "recorder.connect.host.invalid",
            HostError::NotHttps => "recorder.connect.host.https",
        }
    }
}

/// `https://<host>/connect?challenge=<challenge>&name=<device name>`.
pub fn connect_url(origin: &str, challenge: &str, device_name: &str) -> String {
    format!(
        "{origin}/connect?challenge={challenge}&name={}",
        utf8_percent_encode(device_name, QUERY_VALUE)
    )
}

/// How long the recorder polls before it asks the user to connect again.
pub const POLL_GIVE_UP_SECS: u64 = 600;
pub const POLL_INTERVAL_SECS: u64 = 2;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_code_matches_the_contract_example() {
        assert_eq!(pairing_code("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"), "1MM-SP7");
    }

    #[test]
    fn verifier_and_challenge_have_the_contract_shape() {
        let pkce = Pkce::generate();
        assert_eq!(pkce.verifier.len(), 43);
        assert_eq!(pkce.challenge.len(), 43);
        let ok = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        assert!(ok(&pkce.verifier) && ok(&pkce.challenge));
        assert_eq!(challenge_for(&pkce.verifier), pkce.challenge);
        assert_ne!(Pkce::generate().verifier, pkce.verifier);
        assert!(!format!("{pkce:?}").contains(&pkce.verifier));
    }

    #[test]
    fn rfc7636_appendix_b() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn device_name_is_cleaned_and_shortened() {
        assert_eq!(device_name("  Mettes MacBook Pro  "), "Mettes MacBook Pro");
        assert_eq!(device_name("Kontor\u{200F} Ærø\u{0007}"), "Kontor Ærø");
        // A decomposed Æ is composed (NFC).
        assert_eq!(device_name("A\u{030A}rhus"), "Århus");
        assert_eq!(device_name("\u{2028}\u{202E}"), "Recorder");
        let long = "x".repeat(80);
        assert_eq!(device_name(&long).chars().count(), 64);
        // Truncation then trim: a space at position 64 does not survive.
        let spaced = format!("{} {}", "a".repeat(63), "b".repeat(10));
        assert_eq!(device_name(&spaced), "a".repeat(63));
    }

    #[test]
    fn connect_url_percent_encodes_the_name() {
        assert_eq!(
            connect_url("https://m.example.com", "abc", "Kontor Ærø"),
            "https://m.example.com/connect?challenge=abc&name=Kontor%20%C3%86r%C3%B8"
        );
        assert_eq!(connect_url("https://h.io", "c", "a-b.c_d~e+f"), "https://h.io/connect?challenge=c&name=a-b.c_d~e%2Bf");
    }

    #[test]
    fn hosts_are_normalised_to_an_origin() {
        assert_eq!(normalise_host("meetings.acme.com").unwrap(), "https://meetings.acme.com");
        assert_eq!(normalise_host(" https://app.mtxt.co/meetings?x=1 ").unwrap(), "https://app.mtxt.co");
        assert_eq!(normalise_host("localhost:8788").unwrap(), "http://localhost:8788");
        assert_eq!(normalise_host("http://127.0.0.1:8788/").unwrap(), "http://127.0.0.1:8788");
        assert_eq!(normalise_host("http://meetings.acme.com"), Err(HostError::NotHttps));
        assert_eq!(normalise_host(""), Err(HostError::Empty));
        assert_eq!(normalise_host("not a host"), Err(HostError::Invalid));
        assert_eq!(normalise_host("intranet"), Err(HostError::Invalid));
        assert_eq!(normalise_host("ftp://x.com"), Err(HostError::Invalid));
    }
}
