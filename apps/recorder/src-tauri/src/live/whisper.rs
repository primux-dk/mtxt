//! Whisper large-v3-turbo through whisper.cpp (whisper-rs), with Metal.

use super::Engine;
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

pub struct Whisper {
    // The state borrows nothing from the context in whisper-rs 0.16, but the
    // context must outlive it; keep both.
    _ctx: WhisperContext,
    state: WhisperState,
}

impl Whisper {
    pub fn load(dir: &Path) -> Result<Whisper, String> {
        whisper_rs::install_logging_hooks();
        let path = dir.join(super::models::WHISPER.files[0].name);
        let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default()).map_err(|e| e.to_string())?;
        let state = ctx.create_state().map_err(|e| e.to_string())?;
        Ok(Whisper { _ctx: ctx, state })
    }
}

impl Engine for Whisper {
    fn transcribe(&mut self, audio: &[f32]) -> Result<String, String> {
        if audio.len() < 16_000 / 2 {
            return Ok(String::new());
        }
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("auto"));
        params.set_no_context(true);
        params.set_single_segment(true);
        params.set_no_timestamps(true);
        params.set_suppress_blank(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_n_threads(std::thread::available_parallelism().map(|n| n.get().clamp(1, 4) as i32).unwrap_or(2));
        // Whisper reads at least a second; pad a short utterance with silence.
        let mut padded;
        let input = if audio.len() < 16_000 {
            padded = audio.to_vec();
            padded.resize(16_000 + 1_600, 0.0);
            &padded[..]
        } else {
            audio
        };
        self.state.full(params, input).map_err(|e| e.to_string())?;
        let mut text = String::new();
        for segment in self.state.as_iter() {
            if let Ok(s) = segment.to_str_lossy() {
                text.push_str(&s);
            }
        }
        Ok(text.split_whitespace().collect::<Vec<_>>().join(" "))
    }
}
