//! The HTTP side of the contract: the token poll, disconnect and the four
//! recording endpoints. Every answer is mapped to a value the caller can act
//! on; nothing here retries on its own.

use crate::connect::Pkce;
use crate::contract::*;
use reqwest::{header, Client, StatusCode, Url};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// No answer: offline, DNS, TLS, timeout.
    #[error("network: {0}")]
    Network(String),
    /// 401: the token is unknown, expired or revoked.
    #[error("unauthorized")]
    Unauthorized,
    /// 409 with the contract's `Conflict` body.
    #[error("conflict: {}", .0.reason)]
    Conflict(Conflict),
    /// Any other status, with the contract's error code when the body had one.
    #[error("status {status}: {code}")]
    Status { status: u16, code: String },
    /// A 2xx whose body did not parse.
    #[error("unexpected answer: {0}")]
    Decode(String),
}

impl ApiError {
    /// Worth another attempt later without anyone doing anything.
    pub fn is_retryable(&self) -> bool {
        match self {
            ApiError::Network(_) | ApiError::Decode(_) => true,
            ApiError::Status { status, .. } => *status >= 500 || *status == 429 || *status == 408,
            _ => false,
        }
    }
}

/// What one token poll said.
#[derive(Debug)]
pub enum PollResult {
    Token(RecorderToken),
    Pending { retry_after: u64 },
    /// 410: `expired` or `denied`. Stop and connect again.
    Gone { code: String },
    RateLimited { retry_after: u64 },
    /// 400 or 413: a bug in the recorder. Stop.
    Refused { code: String },
    /// 5xx or no answer: poll again after 2 seconds.
    TryAgain,
}

#[derive(Clone)]
pub struct Api {
    client: Client,
    origin: Url,
}

pub const USER_AGENT: &str = concat!("mtxt-recorder/", env!("CARGO_PKG_VERSION"));

impl Api {
    pub fn new(origin: &str) -> Result<Api, ApiError> {
        let origin = Url::parse(origin).map_err(|e| ApiError::Decode(e.to_string()))?;
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| ApiError::Network(e.to_string()))?;
        Ok(Api { client, origin })
    }

    pub fn origin(&self) -> &Url {
        &self.origin
    }

    fn url(&self, path: &str) -> Url {
        self.origin.join(path).expect("a path under the origin")
    }

    pub async fn poll_token(&self, pkce: &Pkce) -> PollResult {
        let body = RecorderTokenRequest { challenge: pkce.challenge.clone(), verifier: pkce.verifier.clone() };
        let res = self
            .client
            .post(self.url("/api/v1/recorder/token"))
            .timeout(Duration::from_secs(20))
            .json(&body)
            .send()
            .await;
        let res = match res {
            Ok(r) => r,
            Err(_) => return PollResult::TryAgain,
        };
        let status = res.status();
        let retry_after = retry_after(&res);
        match status {
            StatusCode::OK => match res.json::<RecorderToken>().await {
                Ok(token) => PollResult::Token(token),
                Err(_) => PollResult::Refused { code: "decode".into() },
            },
            StatusCode::ACCEPTED => PollResult::Pending { retry_after: retry_after.unwrap_or(2).max(1) },
            StatusCode::GONE => PollResult::Gone { code: error_code(res).await },
            StatusCode::TOO_MANY_REQUESTS => PollResult::RateLimited { retry_after: retry_after.unwrap_or(1).max(1) },
            s if s.is_server_error() => PollResult::TryAgain,
            _ => PollResult::Refused { code: error_code(res).await },
        }
    }

    pub async fn revoke(&self, token: &str, token_id: &str) -> Result<(), ApiError> {
        let path = format!("/api/v1/recorder/tokens/{}", encode_segment(token_id));
        let res = self
            .client
            .delete(self.url(&path))
            .bearer_auth(token)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(network)?;
        match res.status() {
            StatusCode::NO_CONTENT => Ok(()),
            _ => Err(fail(res).await),
        }
    }

    pub async fn create(&self, token: &str, body: &CreateRecordingRequest) -> Result<CreateRecordingResponse, ApiError> {
        let res = self
            .client
            .post(self.url("/api/v1/recordings"))
            .bearer_auth(token)
            .timeout(Duration::from_secs(30))
            .json(body)
            .send()
            .await
            .map_err(network)?;
        if res.status() == StatusCode::CREATED || res.status() == StatusCode::OK {
            return res.json().await.map_err(|e| ApiError::Decode(e.to_string()));
        }
        Err(fail(res).await)
    }

    /// The chunk URL: the create response's `upload_url` (absolute, or a path
    /// on the install) and `/{n}`.
    pub fn chunk_url(&self, upload_url: &str, n: u64) -> Result<Url, ApiError> {
        let base = self.origin.join(upload_url).map_err(|e| ApiError::Decode(e.to_string()))?;
        if base.origin() != self.origin.origin() {
            // The bearer token goes to the install only.
            return Err(ApiError::Decode("upload_url on another origin".into()));
        }
        let joined = format!("{}/{n}", base.as_str().trim_end_matches('/'));
        Url::parse(&joined).map_err(|e| ApiError::Decode(e.to_string()))
    }

    pub async fn put_chunk(&self, token: &str, url: Url, bytes: Vec<u8>) -> Result<ChunkReceipt, ApiError> {
        let res = self
            .client
            .put(url)
            .bearer_auth(token)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .timeout(Duration::from_secs(300))
            .body(bytes)
            .send()
            .await
            .map_err(network)?;
        if res.status() == StatusCode::OK {
            return res.json().await.map_err(|e| ApiError::Decode(e.to_string()));
        }
        Err(fail(res).await)
    }

    pub async fn complete(&self, token: &str, id: &str, body: &CompleteRecordingRequest) -> Result<Recording, ApiError> {
        let path = format!("/api/v1/recordings/{}/complete", encode_segment(id));
        let res = self
            .client
            .post(self.url(&path))
            .bearer_auth(token)
            .timeout(Duration::from_secs(120))
            .json(body)
            .send()
            .await
            .map_err(network)?;
        if res.status() == StatusCode::OK {
            return res.json().await.map_err(|e| ApiError::Decode(e.to_string()));
        }
        Err(fail(res).await)
    }

    pub async fn get(&self, token: &str, id: &str) -> Result<Recording, ApiError> {
        let path = format!("/api/v1/recordings/{}", encode_segment(id));
        let res = self
            .client
            .get(self.url(&path))
            .bearer_auth(token)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(network)?;
        if res.status() == StatusCode::OK {
            return res.json().await.map_err(|e| ApiError::Decode(e.to_string()));
        }
        Err(fail(res).await)
    }
}

fn network(e: reqwest::Error) -> ApiError {
    ApiError::Network(e.without_url().to_string())
}

fn retry_after(res: &reqwest::Response) -> Option<u64> {
    res.headers().get(header::RETRY_AFTER)?.to_str().ok()?.trim().parse().ok()
}

async fn error_code(res: reqwest::Response) -> String {
    match res.json::<Error>().await {
        Ok(e) => e.error.code,
        Err(_) => "unknown".into(),
    }
}

/// Map a non-success answer to an error. A 409 keeps its `Conflict` body; a
/// `busy` without `retry_after` in the body takes the header's.
async fn fail(res: reqwest::Response) -> ApiError {
    let status = res.status();
    if status == StatusCode::UNAUTHORIZED {
        return ApiError::Unauthorized;
    }
    let header_retry = retry_after(&res);
    let text = res.text().await.unwrap_or_default();
    if status == StatusCode::CONFLICT {
        if let Ok(mut c) = serde_json::from_str::<Conflict>(&text) {
            if c.retry_after.is_none() {
                c.retry_after = header_retry;
            }
            return ApiError::Conflict(c);
        }
    }
    let code = serde_json::from_str::<Error>(&text).map(|e| e.error.code).unwrap_or_else(|_| "unknown".into());
    ApiError::Status { status: status.as_u16(), code }
}

fn encode_segment(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_urls_stay_on_the_install() {
        let api = Api::new("https://app.mtxt.co").unwrap();
        assert_eq!(
            api.chunk_url("/api/v1/recordings/abc/chunks", 3).unwrap().as_str(),
            "https://app.mtxt.co/api/v1/recordings/abc/chunks/3"
        );
        assert_eq!(
            api.chunk_url("https://app.mtxt.co/api/v1/recordings/abc/chunks/", 1).unwrap().as_str(),
            "https://app.mtxt.co/api/v1/recordings/abc/chunks/1"
        );
        assert!(api.chunk_url("https://evil.example/upload", 1).is_err());
    }

    #[test]
    fn retryable_errors() {
        assert!(ApiError::Network("x".into()).is_retryable());
        assert!(ApiError::Status { status: 503, code: "internal".into() }.is_retryable());
        assert!(!ApiError::Status { status: 413, code: "too_large".into() }.is_retryable());
        assert!(!ApiError::Unauthorized.is_retryable());
    }
}
