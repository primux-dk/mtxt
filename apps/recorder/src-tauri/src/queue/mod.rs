//! The upload queue: one JSON state file per recording next to its audio,
//! loaded at start, written after every change, so the queue survives restarts.

pub mod backoff;
pub mod chunks;
pub mod state;
pub mod store;
pub mod uploader;

pub use state::{Event, PendingReason, RecordingState, Status};
