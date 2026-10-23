//! The platform-free half of WASAPI loopback (`capture::windows`): turning
//! the mix format's bytes into mono samples, and filling the silence Windows
//! leaves out. Compiled everywhere so its tests run on every platform.
//!
//! Loopback delivers no packets while nothing plays. Left alone, the ring
//! would run dry, the mixer would pad its own silence, and when sound came
//! back it would be written up to 200 ms early against the microphone (the
//! mixer's latency, gone from the queue). `SilenceFill` keeps the source on
//! the wall clock instead: when no packet has come for a while, it owes the
//! ring the frames that time covered, as zeros.

#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use super::{push_mono, Sink};
use std::time::{Duration, Instant};

/// How each sample of the mix format is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleKind {
    F32,
    I16,
    /// Three bytes, little-endian, the top 24 bits of a 32-bit sample.
    I24,
    /// 32-bit integer; a 24-bit format in a 32-bit container is left-justified,
    /// so it reads the same way.
    I32,
}

impl SampleKind {
    /// From `WAVEFORMATEX`: the tag, bits per sample, and, for
    /// WAVE_FORMAT_EXTENSIBLE, whether the subformat is float or PCM.
    pub fn from_format(tag: u16, bits: u16, extensible_float: Option<bool>) -> Option<SampleKind> {
        const PCM: u16 = 1;
        const IEEE_FLOAT: u16 = 3;
        const EXTENSIBLE: u16 = 0xFFFE;
        let float = match (tag, extensible_float) {
            (IEEE_FLOAT, _) => true,
            (PCM, _) => false,
            (EXTENSIBLE, Some(f)) => f,
            _ => return None,
        };
        match (float, bits) {
            (true, 32) => Some(SampleKind::F32),
            (false, 16) => Some(SampleKind::I16),
            (false, 24) => Some(SampleKind::I24),
            (false, 32) => Some(SampleKind::I32),
            _ => None,
        }
    }

    pub fn bytes(self) -> usize {
        match self {
            SampleKind::I16 => 2,
            SampleKind::I24 => 3,
            SampleKind::F32 | SampleKind::I32 => 4,
        }
    }

    fn sample(self, b: &[u8]) -> f32 {
        match self {
            SampleKind::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            SampleKind::I16 => f32::from(i16::from_le_bytes([b[0], b[1]])) / 32_768.0,
            SampleKind::I24 => i32::from_le_bytes([0, b[0], b[1], b[2]]) as f32 / 2_147_483_648.0,
            SampleKind::I32 => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
        }
    }
}

/// Decode interleaved frames and average them into the ring, through a
/// scratch buffer the caller keeps between packets.
pub fn push_bytes(sink: &mut Sink, data: &[u8], kind: SampleKind, channels: usize, scratch: &mut Vec<f32>) {
    let channels = channels.max(1);
    scratch.clear();
    scratch.extend(data.chunks_exact(kind.bytes()).map(|b| kind.sample(b)));
    let whole = scratch.len() / channels * channels;
    push_mono(sink, &scratch[..whole], channels, |s| s);
}

/// Zeros into the ring, for a silent packet or a stretch without packets.
pub fn push_silence(sink: &mut Sink, frames: usize) {
    const BLOCK: [f32; 512] = [0.0; 512];
    let mut left = frames;
    while left > 0 {
        let n = left.min(BLOCK.len());
        push_mono(sink, &BLOCK[..n], 1, |s| s);
        left -= n;
    }
}

/// Keeps a loopback source on the wall clock across silence.
#[derive(Debug, Clone)]
pub struct SilenceFill {
    rate: u32,
    /// When the last packet came, and the frame count right after it.
    anchor: Instant,
    anchor_frames: u64,
    delivered: u64,
}

/// Packets come every device period (about 10 ms); longer than this without
/// one is silence.
pub const QUIET_AFTER: Duration = Duration::from_millis(30);

impl SilenceFill {
    pub fn new(rate: u32, now: Instant) -> SilenceFill {
        SilenceFill { rate: rate.max(1), anchor: now, anchor_frames: 0, delivered: 0 }
    }

    /// A packet of `frames` went into the ring at `now`.
    pub fn packet(&mut self, frames: u64, now: Instant) {
        self.delivered += frames;
        self.anchor = now;
        self.anchor_frames = self.delivered;
    }

    /// Frames of silence the ring is owed at `now`, counted as delivered.
    pub fn owed(&mut self, now: Instant) -> u64 {
        let since = now.saturating_duration_since(self.anchor);
        if since < QUIET_AFTER {
            return 0;
        }
        let expected = self.anchor_frames + (since.as_secs_f64() * f64::from(self.rate)) as u64;
        let owed = expected.saturating_sub(self.delivered);
        self.delivered += owed;
        owed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mix_formats() {
        assert_eq!(SampleKind::from_format(0xFFFE, 32, Some(true)), Some(SampleKind::F32));
        assert_eq!(SampleKind::from_format(3, 32, None), Some(SampleKind::F32));
        assert_eq!(SampleKind::from_format(1, 16, None), Some(SampleKind::I16));
        assert_eq!(SampleKind::from_format(0xFFFE, 24, Some(false)), Some(SampleKind::I24));
        assert_eq!(SampleKind::from_format(0xFFFE, 32, Some(false)), Some(SampleKind::I32));
        assert_eq!(SampleKind::from_format(0xFFFE, 64, Some(true)), None);
        assert_eq!(SampleKind::from_format(0x0055, 16, None), None);
    }

    #[test]
    fn bytes_are_decoded_and_averaged() {
        let (mut p, mut c) = rtrb::RingBuffer::<f32>::new(16);
        let mut scratch = Vec::new();
        // Stereo f32: (0.5, -0.5) and (1.0, 0.0).
        let data: Vec<u8> = [0.5f32, -0.5, 1.0, 0.0].iter().flat_map(|s| s.to_le_bytes()).collect();
        push_bytes(&mut p, &data, SampleKind::F32, 2, &mut scratch);
        assert_eq!(c.pop().unwrap(), 0.0);
        assert_eq!(c.pop().unwrap(), 0.5);
        // Mono i16 at half scale, and 24-bit at minus full scale.
        push_bytes(&mut p, &16_384i16.to_le_bytes(), SampleKind::I16, 1, &mut scratch);
        assert_eq!(c.pop().unwrap(), 0.5);
        push_bytes(&mut p, &[0x00, 0x00, 0x80], SampleKind::I24, 1, &mut scratch);
        assert_eq!(c.pop().unwrap(), -1.0);
        // A trailing half frame is dropped, not misread.
        push_bytes(&mut p, &[0u8; 12], SampleKind::F32, 2, &mut scratch);
        assert_eq!(c.slots(), 1);
    }

    #[test]
    fn silence_fills_the_ring() {
        let (mut p, c) = rtrb::RingBuffer::<f32>::new(2_000);
        push_silence(&mut p, 1_234);
        assert_eq!(c.slots(), 1_234);
    }

    #[test]
    fn silence_is_owed_only_after_a_quiet_stretch() {
        let t0 = Instant::now();
        let mut f = SilenceFill::new(48_000, t0);
        f.packet(480, t0);
        // Packets every 10 ms: nothing owed.
        assert_eq!(f.owed(t0 + Duration::from_millis(10)), 0);
        f.packet(480, t0 + Duration::from_millis(10));
        // 100 ms of nothing after the last packet: 100 ms of zeros.
        assert_eq!(f.owed(t0 + Duration::from_millis(110)), 4_800);
        // Asked again 10 ms later: only the new 10 ms.
        assert_eq!(f.owed(t0 + Duration::from_millis(120)), 480);
        // Sound comes back; the count carries on from the zeros.
        f.packet(480, t0 + Duration::from_millis(125));
        assert_eq!(f.owed(t0 + Duration::from_millis(130)), 0);
        assert_eq!(f.delivered, 480 * 3 + 4_800 + 480);
    }

    #[test]
    fn the_count_restarts_at_each_packet() {
        let t0 = Instant::now();
        let mut f = SilenceFill::new(48_000, t0);
        // A packet larger than the time since the start: the count follows the
        // packet, and silence is owed only for time after it.
        f.packet(48_000, t0 + Duration::from_millis(500));
        assert_eq!(f.owed(t0 + Duration::from_millis(520)), 0);
        assert!(f.owed(t0 + Duration::from_millis(600)) > 0);
    }
}
