//! The platform-free half of WASAPI loopback (`capture::windows`): turning
//! the mix format's bytes into mono samples, and filling the silence Windows
//! leaves out. Compiled everywhere so its tests run on every platform.
//!
//! Loopback delivers no packets while nothing plays. Left alone, the ring
//! would run dry, the mixer would pad its own silence, and when sound came
//! back it would be written up to 200 ms early against the microphone (the
//! mixer's latency, gone from the queue). `Timeline` keeps the source on one
//! clock instead: each packet carries the QPC time of its first frame, so a
//! gap between packets becomes zeros, an overlap is cut, and a stretch with no
//! packets is filled up to a little before now. Times are in 100 ns units,
//! the unit WASAPI gives the QPC position in.

#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use super::{push_mono, Sink};

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

/// 100 ns units per second.
pub const TICKS: u64 = 10_000_000;
/// A gap or an overlap smaller than this is rounding, not time.
pub const SLACK: u64 = TICKS / 500; // 2 ms
/// Silence is filled up to this far behind now. A packet arrives one device
/// period (about 10 ms) after its first frame; filling closer to now would
/// write zeros over sound that is on its way.
pub const FILL_LAG: u64 = TICKS / 20; // 50 ms

/// What a packet needs before it goes into the ring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Place {
    /// Zeros for the gap before it.
    pub zeros: u64,
    /// Frames at its start that are already covered.
    pub skip: u64,
}

/// The source's position on the QPC clock: the time just after the last
/// frame that went into the ring.
#[derive(Debug, Clone)]
pub struct Timeline {
    rate: u64,
    next: u64,
}

impl Timeline {
    /// The stream opened at `now`: the ring is owed sound from then on.
    pub fn new(rate: u32, now: u64) -> Timeline {
        Timeline { rate: u64::from(rate.max(1)), next: now }
    }

    /// A reopened device can bring another rate; the clock carries on.
    pub fn set_rate(&mut self, rate: u32) {
        self.rate = u64::from(rate.max(1));
    }

    fn frames(&self, ticks: u64) -> u64 {
        ticks * self.rate / TICKS
    }

    fn ticks(&self, frames: u64) -> u64 {
        frames * TICKS / self.rate
    }

    /// A packet of `frames` whose first frame is at `at`. Without a usable
    /// timestamp (`None`), it follows the last frame.
    pub fn packet(&mut self, at: Option<u64>, frames: u64) -> Place {
        let at = at.unwrap_or(self.next);
        let mut place = Place { zeros: 0, skip: 0 };
        if at > self.next + SLACK {
            place.zeros = self.frames(at - self.next);
        } else if at + SLACK < self.next {
            place.skip = self.frames(self.next - at).min(frames);
        }
        self.next = self.next.max(at + self.ticks(frames));
        place
    }

    /// Zeros owed at `now` for a stretch without packets, up to `FILL_LAG`
    /// behind now.
    pub fn silence(&mut self, now: u64) -> u64 {
        let until = now.saturating_sub(FILL_LAG);
        if until <= self.next + SLACK {
            return 0;
        }
        let zeros = self.frames(until - self.next);
        self.next += self.ticks(zeros);
        zeros
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

    const MS: u64 = TICKS / 1000;

    /// Feed packets and quiet polls; count the frames that reach the ring.
    fn run(t: &mut Timeline, steps: &[(u64, Option<(u64, u64)>)]) -> u64 {
        let mut total = 0;
        for &(now, packet) in steps {
            match packet {
                Some((at, frames)) => {
                    let p = t.packet(Some(at), frames);
                    total += p.zeros + frames - p.skip;
                }
                None => total += t.silence(now),
            }
        }
        total
    }

    #[test]
    fn continuous_packets_are_written_once() {
        // 40 ms packets back to back for a second, arriving 10 ms after their
        // end, with the 10 ms polls between them finding nothing.
        let mut t = Timeline::new(48_000, 0);
        let mut steps = Vec::new();
        for i in 0..25 {
            let at = i * 40 * MS;
            steps.push((at + 50 * MS, Some((at, 1_920))));
            for q in 1..4 {
                steps.push((at + 50 * MS + q * 10 * MS, None));
            }
        }
        assert_eq!(run(&mut t, &steps), 48_000);
    }

    #[test]
    fn short_packets_with_gaps_between_them_fill_the_gaps() {
        // 10 ms of sound, 20 ms of nothing, for 300 ms: 300 ms of frames.
        let mut t = Timeline::new(48_000, 0);
        let mut steps = Vec::new();
        for i in 0..10 {
            let at = i * 30 * MS;
            steps.push((at + 15 * MS, Some((at, 480))));
            steps.push((at + 25 * MS, None));
        }
        // The last gap, after the last packet, is owed once its time has passed.
        steps.push((300 * MS + FILL_LAG, None));
        assert_eq!(run(&mut t, &steps), 14_400);
    }

    #[test]
    fn silence_then_sound_lines_up() {
        let mut t = Timeline::new(48_000, 0);
        // Nothing for a second, polled every 10 ms: filled up to 50 ms behind now.
        let quiet: u64 = (1..=100).map(|i| t.silence(i * 10 * MS)).sum();
        assert_eq!(quiet, 48_000 - 2_400);
        // Sound starts at 980 ms, inside the 50 ms not filled yet: only the gap
        // before it is zeros, nothing of the sound is cut.
        let p = t.packet(Some(980 * MS), 480);
        assert_eq!(p, Place { zeros: 1_440, skip: 0 });
        // A packet that starts inside what was filled loses only the overlap.
        let mut t = Timeline::new(48_000, 0);
        t.silence(1_000 * MS);
        assert_eq!(t.packet(Some(940 * MS), 960), Place { zeros: 0, skip: 480 });
    }

    #[test]
    fn a_packet_without_a_timestamp_follows_the_last_frame() {
        let mut t = Timeline::new(48_000, 0);
        assert_eq!(t.packet(Some(0), 480), Place { zeros: 0, skip: 0 });
        assert_eq!(t.packet(None, 480), Place { zeros: 0, skip: 0 });
        assert_eq!(t.packet(Some(20 * MS), 480), Place { zeros: 0, skip: 0 });
    }

    #[test]
    fn a_lost_device_keeps_the_clock() {
        // Sound for 100 ms, then the device is gone for 2 s (the thread fills
        // silence every 10 ms), then a new device at 44.1 kHz delivers sound.
        let mut t = Timeline::new(48_000, 0);
        assert_eq!(t.packet(Some(0), 4_800), Place { zeros: 0, skip: 0 });
        let quiet: u64 = (1..=210).map(|i| t.silence(i * 10 * MS)).sum();
        assert_eq!(quiet, 48 * (2_100 - 50 - 100));
        t.set_rate(44_100);
        // The first packet of the new device starts at 2,080 ms: only the
        // 30 ms not yet filled are zeros, at the new rate.
        assert_eq!(t.packet(Some(2_080 * MS), 441), Place { zeros: 1_323, skip: 0 });
    }
}
