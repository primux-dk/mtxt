//! A recording in progress: the two captures, the mixer thread, the encoder.
//!
//! The mixer runs on the wall clock, 200 ms behind it, and takes 20 ms frames
//! from each source's queue: microphone left, system audio right, as Opus in
//! Ogg. A source that is short pads silence; one that runs more than 600 ms
//! ahead (clock drift over hours, or a stall) is trimmed back to 200 ms. The
//! same frames, averaged to mono and resampled to 16 kHz, feed the live
//! transcript when it is on.

use super::capture::{self, Capture, CaptureError, RING_SAMPLES};
use super::ogg_opus::{OggOpusWriter, FRAME, RATE};
use super::resample::Resampler;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const LATENCY: Duration = Duration::from_millis(200);
const MAX_AHEAD: usize = (RATE as usize) * 6 / 10;
const TRIM_TO: usize = (RATE as usize) / 5;
pub const LIVE_RATE: u32 = 16_000;

/// Meter values 0.0..=1.0, read by the window ten times a second.
#[derive(Default)]
pub struct Levels {
    mic: AtomicU32,
    system: AtomicU32,
}

impl Levels {
    pub fn get(&self) -> (f32, f32) {
        (f32::from_bits(self.mic.load(Ordering::Relaxed)), f32::from_bits(self.system.load(Ordering::Relaxed)))
    }
    fn set(&self, mic: f32, system: f32) {
        self.mic.store(mic.to_bits(), Ordering::Relaxed);
        self.system.store(system.to_bits(), Ordering::Relaxed);
    }
}

/// RMS of a block as a meter value: -60 dBFS is empty, 0 dBFS full.
pub fn meter(block: &[f32]) -> f32 {
    if block.is_empty() {
        return 0.0;
    }
    let rms = (block.iter().map(|s| s * s).sum::<f32>() / block.len() as f32).sqrt();
    if rms <= 1e-6 {
        return 0.0;
    }
    ((20.0 * rms.log10() + 60.0) / 60.0).clamp(0.0, 1.0)
}

/// Where the live transcript gets its 16 kHz mono samples. The mixer pushes
/// only while `enabled`; the live thread swaps in a fresh ring when it starts.
#[derive(Default)]
pub struct LiveFeed {
    pub enabled: AtomicBool,
    pub sink: Mutex<Option<rtrb::Producer<f32>>>,
}

/// How each source started.
#[derive(Debug, Clone)]
pub struct SourceStatus {
    pub microphone: Result<(), CaptureError>,
    pub system_audio: Result<(), CaptureError>,
}

pub struct Recording {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<std::io::Result<f64>>>,
    captures: Vec<Box<dyn Capture>>,
    pub levels: Arc<Levels>,
    pub started: Instant,
    pub sources: SourceStatus,
    pub path: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("no source: microphone {mic}, system audio {system}")]
    NoSource { mic: CaptureError, system: CaptureError },
    #[error("file: {0}")]
    File(#[from] std::io::Error),
}

pub fn start(path: &Path, live: Arc<LiveFeed>) -> Result<Recording, StartError> {
    let (mic_tx, mic_rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
    let (sys_tx, sys_rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
    let mic = capture::microphone(mic_tx);
    let system = capture::system_audio(sys_tx);
    let sources = SourceStatus {
        microphone: mic.as_ref().map(|_| ()).map_err(Clone::clone),
        system_audio: system.as_ref().map(|_| ()).map_err(Clone::clone),
    };
    let (mic, system) = match (mic, system) {
        (Err(m), Err(s)) => return Err(StartError::NoSource { mic: m, system: s }),
        (m, s) => (m.ok(), s.ok()),
    };
    let writer = OggOpusWriter::create(path)?;
    let mic_rate = mic.as_ref().map(|c| c.rate()).unwrap_or(RATE);
    let sys_rate = system.as_ref().map(|c| c.rate()).unwrap_or(RATE);
    log::info!("recording: microphone {mic_rate} Hz {:?}, system {sys_rate} Hz {:?}", sources.microphone, sources.system_audio);

    let stop = Arc::new(AtomicBool::new(false));
    let levels = Arc::new(Levels::default());
    let mixer = Mixer::new(writer, mic_rx, mic_rate, sys_rx, sys_rate, levels.clone(), live);
    let stop_flag = stop.clone();
    let thread = std::thread::Builder::new().name("mixer".into()).spawn(move || mixer.run(stop_flag))?;
    let captures: Vec<Box<dyn Capture>> = mic.into_iter().chain(system).collect();
    Ok(Recording { stop, thread: Some(thread), captures, levels, started: Instant::now(), sources, path: path.to_path_buf() })
}

impl Recording {
    /// Stop the captures, write what is left, close the file. Seconds of audio.
    pub fn finish(mut self) -> std::io::Result<f64> {
        // The mixer stops first and closes the file, so the recording ends when
        // Stop was pressed. The devices are released on their own thread: a
        // Core Audio device can take seconds to let go, and nothing waits on it.
        self.stop.store(true, Ordering::SeqCst);
        let result = match self.thread.take().map(|t| t.join()) {
            Some(Ok(result)) => result,
            _ => Err(std::io::Error::other("the mixer thread panicked")),
        };
        let mut captures = std::mem::take(&mut self.captures);
        let _ = std::thread::Builder::new().name("release-devices".into()).spawn(move || {
            for c in captures.iter_mut() {
                let t = Instant::now();
                c.stop();
                log::info!("capture released in {:?}", t.elapsed());
            }
        });
        result
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

struct Source {
    rx: rtrb::Consumer<f32>,
    resampler: Resampler,
    queue: VecDeque<f32>,
    scratch: Vec<f32>,
    out: Vec<f32>,
}

impl Source {
    fn new(rx: rtrb::Consumer<f32>, rate: u32) -> Source {
        Source { rx, resampler: Resampler::new(rate, RATE), queue: VecDeque::new(), scratch: Vec::new(), out: Vec::new() }
    }

    fn drain(&mut self) {
        let n = self.rx.slots();
        if n == 0 {
            return;
        }
        self.scratch.clear();
        if let Ok(chunk) = self.rx.read_chunk(n) {
            let (a, b) = chunk.as_slices();
            self.scratch.extend_from_slice(a);
            self.scratch.extend_from_slice(b);
            chunk.commit_all();
        }
        self.out.clear();
        self.resampler.process(&self.scratch, &mut self.out);
        self.queue.extend(self.out.iter().copied());
        if self.queue.len() > MAX_AHEAD {
            let excess = self.queue.len() - TRIM_TO;
            self.queue.drain(..excess);
        }
    }

    fn take(&mut self, frame: &mut [f32]) {
        for slot in frame.iter_mut() {
            *slot = self.queue.pop_front().unwrap_or(0.0);
        }
    }
}

struct Mixer {
    writer: OggOpusWriter,
    mic: Source,
    system: Source,
    levels: Arc<Levels>,
    live: Arc<LiveFeed>,
    live_resampler: Resampler,
}

impl Mixer {
    fn new(
        writer: OggOpusWriter,
        mic_rx: rtrb::Consumer<f32>,
        mic_rate: u32,
        sys_rx: rtrb::Consumer<f32>,
        sys_rate: u32,
        levels: Arc<Levels>,
        live: Arc<LiveFeed>,
    ) -> Mixer {
        Mixer {
            writer,
            mic: Source::new(mic_rx, mic_rate),
            system: Source::new(sys_rx, sys_rate),
            levels,
            live,
            live_resampler: Resampler::new(RATE, LIVE_RATE),
        }
    }

    fn run(mut self, stop: Arc<AtomicBool>) -> std::io::Result<f64> {
        let started = Instant::now();
        let mut written: u64 = 0;
        let mut last_sync = Instant::now();
        let mut buffers = Frames::default();
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));
            self.mic.drain();
            self.system.drain();
            let behind = started.elapsed().saturating_sub(LATENCY);
            let target = (behind.as_secs_f64() * f64::from(RATE)) as u64;
            while written + FRAME as u64 <= target {
                self.frame(&mut buffers)?;
                written += FRAME as u64;
            }
            if last_sync.elapsed() >= Duration::from_secs(5) {
                self.writer.sync()?;
                last_sync = Instant::now();
            }
        }
        // The captures are stopped: write what they left, then close.
        self.mic.drain();
        self.system.drain();
        let left = self.mic.queue.len().max(self.system.queue.len());
        for _ in 0..left.div_ceil(FRAME) {
            self.frame(&mut buffers)?;
        }
        self.levels.set(0.0, 0.0);
        self.writer.finish()
    }

    fn frame(&mut self, f: &mut Frames) -> std::io::Result<()> {
        self.mic.take(&mut f.mic);
        self.system.take(&mut f.system);
        for i in 0..FRAME {
            f.stereo[2 * i] = f.mic[i];
            f.stereo[2 * i + 1] = f.system[i];
        }
        self.writer.write_frame(&f.stereo)?;
        self.levels.set(meter(&f.mic), meter(&f.system));
        if self.live.enabled.load(Ordering::Relaxed) {
            for i in 0..FRAME {
                f.mono[i] = 0.5 * (f.mic[i] + f.system[i]);
            }
            f.live.clear();
            self.live_resampler.process(&f.mono, &mut f.live);
            if let Ok(mut guard) = self.live.sink.try_lock() {
                if let Some(sink) = guard.as_mut() {
                    capture::push_mono(sink, &f.live, 1, |s| s);
                }
            }
        }
        Ok(())
    }
}

struct Frames {
    mic: Vec<f32>,
    system: Vec<f32>,
    stereo: Vec<f32>,
    mono: Vec<f32>,
    live: Vec<f32>,
}

impl Default for Frames {
    fn default() -> Self {
        Frames {
            mic: vec![0.0; FRAME],
            system: vec![0.0; FRAME],
            stereo: vec![0.0; FRAME * 2],
            mono: vec![0.0; FRAME],
            live: Vec::with_capacity(FRAME),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meter_maps_dbfs_to_zero_one() {
        assert_eq!(meter(&[]), 0.0);
        assert_eq!(meter(&[0.0; 960]), 0.0);
        assert!((meter(&[1.0; 960]) - 1.0).abs() < 1e-6);
        // -20 dBFS sits two thirds up.
        assert!((meter(&[0.1; 960]) - 2.0 / 3.0).abs() < 1e-3);
    }

    #[test]
    fn a_source_far_ahead_is_trimmed_and_a_short_one_pads_silence() {
        let (mut tx, rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
        let mut s = Source::new(rx, RATE);
        for _ in 0..RATE {
            tx.push(0.5).unwrap();
        }
        s.drain();
        assert_eq!(s.queue.len(), TRIM_TO);
        let mut frame = vec![1.0; FRAME];
        let (_tx2, rx2) = rtrb::RingBuffer::<f32>::new(16);
        let mut empty = Source::new(rx2, RATE);
        empty.take(&mut frame);
        assert!(frame.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn the_mixer_puts_the_microphone_left_and_the_system_right() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.ogg");
        let (mut mic_tx, mic_rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
        let (mut sys_tx, sys_rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
        let live = Arc::new(LiveFeed::default());
        let (live_tx, mut live_rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
        *live.sink.lock().unwrap() = Some(live_tx);
        live.enabled.store(true, Ordering::SeqCst);
        let levels = Arc::new(Levels::default());
        let mut mixer =
            Mixer::new(OggOpusWriter::create(&path).unwrap(), mic_rx, 44_100, sys_rx, RATE, levels.clone(), live);
        for i in 0..44_100 {
            mic_tx.push((i as f32 * 0.05).sin() * 0.5).unwrap();
        }
        for _ in 0..RATE {
            sys_tx.push(0.0).unwrap();
        }
        mixer.mic.drain();
        mixer.system.drain();
        let mut f = Frames::default();
        for _ in 0..10 {
            mixer.frame(&mut f).unwrap();
        }
        let (mic_level, sys_level) = levels.get();
        assert!(mic_level > 0.5 && sys_level == 0.0, "{mic_level} {sys_level}");
        assert!(f.stereo[1] == 0.0 && f.stereo.iter().step_by(2).any(|v| v.abs() > 0.1));
        // 10 frames of 20 ms at 16 kHz: about 3,200 live samples.
        assert!((live_rx.slots() as i64 - 3_200).abs() < 40, "{}", live_rx.slots());
        let _ = live_rx.pop();
        let secs = mixer.writer.finish().unwrap();
        assert!((secs - 0.22).abs() < 1e-6);
    }
}
