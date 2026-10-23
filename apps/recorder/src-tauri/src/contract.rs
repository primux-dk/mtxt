//! The recorder-to-server contract, hand-written from `packages/contract/openapi.yaml`.
//!
//! Only the structs the recorder sends or reads. `tests/contract.rs` checks
//! every field name and every required list here against the OpenAPI file, so
//! a change to the contract that this file misses fails the build.

use serde::{Deserialize, Serialize};

/// `POST /recorder/token` body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecorderTokenRequest {
    pub challenge: String,
    pub verifier: String,
}

/// `POST /recorder/token` 200.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecorderToken {
    pub token: String,
    pub token_id: String,
    pub expires_at: String,
    pub device_name: String,
    pub user: RecorderUser,
    pub install: RecorderInstall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecorderUser {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecorderInstall {
    pub product_name: String,
    pub theme_accent: String,
    pub theme_primary: String,
    /// Absent from a server older than packet 9; the recorder then uses the OS language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_language: Option<String>,
    /// Absent from a server older than packet 9; the recorder then keeps live text off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_transcript_default: Option<bool>,
}

/// `POST /recorder/token` 202.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecorderTokenPending {
    pub status: String,
}

/// `NewMeeting`: the meeting a desktop recording creates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewMeeting {
    pub title: String,
    pub started_at: String,
}

/// `CreateRecordingRequest`, the `ForNewMeeting` branch. The desktop recorder
/// always has the whole file, so `sha256` and `size_bytes` go here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CreateRecordingRequest {
    pub meeting: NewMeeting,
    pub duration_s: u64,
    pub sha256: String,
    pub size_bytes: u64,
    pub source: String,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CreateRecordingResponse {
    pub id: String,
    pub meeting_id: String,
    pub upload_url: String,
    pub chunk_size_bytes: u64,
    pub chunk_count: Option<u64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChunkReceipt {
    pub n: u64,
    pub size_bytes: u64,
    pub chunks_received: Vec<u64>,
    pub chunk_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompleteRecordingRequest {
    pub sha256: String,
    pub size_bytes: u64,
    pub duration_s: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Recording {
    pub id: String,
    pub meeting_id: String,
    pub status: String,
    pub sha256: Option<String>,
    pub size_bytes: Option<u64>,
    pub duration_s: u64,
    pub source: String,
    pub created_at: String,
    pub chunk_count: Option<u64>,
    pub chunks_received: Vec<u64>,
    #[serde(default)]
    pub confirmed_at: Option<String>,
    #[serde(default)]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// `Error`: every 4xx and 5xx that is not a 409.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Error {
    pub error: ErrorBody,
}

/// `Conflict`: every 409.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Conflict {
    pub error: ErrorBody,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing: Option<Vec<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

/// `RateLimited`: the token poll's 429.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RateLimited {
    pub error: ErrorBody,
    pub retry_after: u64,
}

/// The status words of `RecordingStatus`.
pub mod status {
    pub const UPLOADING: &str = "uploading";
    pub const CONFIRMED: &str = "confirmed";
    pub const TRANSCRIBING: &str = "transcribing";
    pub const TRANSCRIBED: &str = "transcribed";
    pub const FAILED: &str = "failed";
}

/// What a desktop recording is announced as.
pub const SOURCE_DESKTOP: &str = "desktop";
pub const CONTENT_TYPE_OGG_OPUS: &str = "audio/ogg; codecs=opus";
/// The server refuses a file larger than this (`RecordingDetails.size_bytes.maximum`).
pub const MAX_SIZE_BYTES: u64 = 2_147_483_648;
/// `NewMeeting.title.maxLength`, in characters.
pub const MAX_TITLE_CHARS: usize = 500;
