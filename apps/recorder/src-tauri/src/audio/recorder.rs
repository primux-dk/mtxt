//! A recording in progress: the two captures, the mixer thread, the encoder.
//!
//! The mixer runs on the wall clock, 200 ms behind it, and takes 20 ms frames
//! from each source's queue: microphone left, system audio right, as Opus in
//! Ogg. A source that is short pads silence; one that runs more than 600 ms
//! ahead (clock drift over hours, or a stall) is trimmed back to 200 ms. The
//! same frames, averaged to mono and resampled to 16 kHz, feed the live
//! transcript when it is on.
//!
//! A write or sync error (a full disk) stops the mixer at once and is
//! published in `failure()`; the app stops the capture, keeps the partial file
//! and tells the user. A source that is lost leaves silence, noted as a gap.

use super::capture::{self, Capture, CaptureError, SourceShared, SourceState, RING_SAMPLES};
use super::ogg_opus::{OggOpusWriter, FRAME, RATE};
use super::resample::Resampler;
use crate::queue::state::Gap;
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

/// Where the mixer's frames go: the Ogg Opus file, or a test double.
pub trait FrameSink: Send {
    /// One 20 ms frame, interleaved stereo.
    fn write_frame(&mut self, interleaved: &[f32]) -> std::io::Result<()>;
    fn sync(&mut self) -> std::io::Result<()>;
    /// Close the file; seconds of audio.
    fn finish(self: Box<Self>) -> std::io::Result<f64>;
}

impl FrameSink for OggOpusWriter {
    fn write_frame(&mut self, interleaved: &[f32]) -> std::io::Result<()> {
        OggOpusWriter::write_frame(self, interleaved)
    }
    fn sync(&mut self) -> std::io::Result<()> {
        OggOpusWriter::sync(self)
    }
    fn finish(self: Box<Self>) -> std::io::Result<f64> {
        OggOpusWriter::finish(*self)
    }
}

/// How each source started.
#[derive(Debug, Clone)]
pub struct SourceStatus {
    pub microphone: Result<(), CaptureError>,
    pub system_audio: Result<(), CaptureError>,
}

/// What `finish` hands back.
#[derive(Debug, Clone)]
pub struct Finished {
    pub duration_s: f64,
    pub gaps: Vec<Gap>,
}

/// Which sources to open. A source macOS has not allowed is left closed: a
/// Core Audio tap without the permission blocks on the prompt and then
/// delivers silence.
#[derive(Debug, Clone, Copy)]
pub struct Wanted {
    pub microphone: bool,
    pub system_audio: bool,
}

/// What the mixer publishes while it runs.
#[derive(Default)]
pub struct MixerShared {
    failure: Mutex<Option<String>>,
    gaps: Mutex<Vec<Gap>>,
}

impl MixerShared {
    pub fn failure(&self) -> Option<String> {
        self.failure.lock().unwrap().clone()
    }
}

pub struct Recording {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<std::io::Result<f64>>>,
    captures: Vec<Box<dyn Capture>>,
    mic: Option<Arc<SourceShared>>,
    system: Option<Arc<SourceShared>>,
    shared: Arc<MixerShared>,
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

pub fn start(path: &Path, live: Arc<LiveFeed>, wanted: Wanted) -> Result<Recording, StartError> {
    let (mic_tx, mic_rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
    let (sys_tx, sys_rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
    let mic = if wanted.microphone { capture::microphone(mic_tx) } else { Err(CaptureError::PermissionDenied) };
    let system = if wanted.system_audio { capture::system_audio(sys_tx) } else { Err(CaptureError::PermissionDenied) };
    let sources = SourceStatus {
        microphone: mic.as_ref().map(|_| ()).map_err(Clone::clone),
        system_audio: system.as_ref().map(|_| ()).map_err(Clone::clone),
    };
    let (mic, system) = match (mic, system) {
        (Err(m), Err(s)) => return Err(StartError::NoSource { mic: m, system: s }),
        (m, s) => (m.ok(), s.ok()),
    };
    let writer = OggOpusWriter::create(path)?;
    let mic_shared = mic.as_ref().map(|c| c.shared());
    let sys_shared = system.as_ref().map(|c| c.shared());
    log::info!(
        "recording: microphone {:?} {:?}, system {:?} {:?}",
        mic_shared.as_ref().map(|s| s.rate()),
        sources.microphone,
        sys_shared.as_ref().map(|s| s.rate()),
        sources.system_audio
    );
    let stop = Arc::new(AtomicBool::new(false));
    let levels = Arc::new(Levels::default());
    let shared = Arc::new(MixerShared::default());
    let mixer = Mixer::new(
        Box::new(writer),
        Source::new(mic_rx, mic_shared.clone(), "microphone"),
        Source::new(sys_rx, sys_shared.clone(), "system_audio"),
        levels.clone(),
        live,
        shared.clone(),
    );
    let stop_flag = stop.clone();
    let thread = std::thread::Builder::new().name("mixer".into()).spawn(move || mixer.run(stop_flag))?;
    let captures: Vec<Box<dyn Capture>> = mic.into_iter().chain(system).collect();
    Ok(Recording {
        stop,
        thread: Some(thread),
        captures,
        mic: mic_shared,
        system: sys_shared,
        shared,
        levels,
        started: Instant::now(),
        sources,
        path: path.to_path_buf(),
    })
}

impl Recording {
    /// A write or sync error stopped the mixer: the OS error, for the window.
    pub fn failure(&self) -> Option<String> {
        self.shared.failure()
    }

    /// Each source now: on, lost, or not opened.
    pub fn source_states(&self) -> (Option<SourceState>, Option<SourceState>) {
        (self.mic.as_ref().map(|s| s.state()), self.system.as_ref().map(|s| s.state()))
    }

    /// Stop the captures, write what is left, close the file. On a write
    /// failure the error comes back and the partial file stays as it is.
    pub fn finish(mut self) -> std::io::Result<Finished> {
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
        let gaps = std::mem::take(&mut *self.shared.gaps.lock().unwrap());
        result.map(|duration_s| Finished { duration_s, gaps })
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

struct Source {
    rx: rtrb::Consumer<f32>,
    shared: Option<Arc<SourceShared>>,
    name: &'static str,
    rate: u32,
    resampler: Resampler,
    queue: VecDeque<f32>,
    scratch: Vec<f32>,
    out: Vec<f32>,
    /// Start of the current gap, in seconds of output.
    gap_from: Option<f64>,
}

impl Source {
    fn new(rx: rtrb::Consumer<f32>, shared: Option<Arc<SourceShared>>, name: &'static str) -> Source {
        let rate = shared.as_ref().map(|s| s.rate()).unwrap_or(RATE);
        Source {
            rx,
            shared,
            name,
            rate,
            resampler: Resampler::new(rate, RATE),
            queue: VecDeque::new(),
            scratch: Vec::new(),
            out: Vec::new(),
            gap_from: None,
        }
    }

    fn drain(&mut self) {
        // A new device can bring a new rate.
        if let Some(rate) = self.shared.as_ref().map(|s| s.rate()) {
            if rate != self.rate && rate > 0 {
                self.rate = rate;
                self.resampler = Resampler::new(rate, RATE);
            }
        }
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

    /// Open or close a gap at `at` seconds, from the source's state.
    fn note(&mut self, at: f64, gaps: &Mutex<Vec<Gap>>) {
        let lost = self.shared.as_ref().is_some_and(|s| s.state() == SourceState::Lost);
        match (lost, self.gap_from) {
            (true, None) => self.gap_from = Some(at),
            (false, Some(from)) => {
                gaps.lock().unwrap().push(Gap { source: self.name.into(), from_s: from, to_s: at });
                self.gap_from = None;
            }
            _ => {}
        }
    }

    fn close_gap(&mut self, at: f64, gaps: &Mutex<Vec<Gap>>) {
        if let Some(from) = self.gap_from.take() {
            gaps.lock().unwrap().push(Gap { source: self.name.into(), from_s: from, to_s: at });
        }
    }
}

struct Mixer {
    writer: Option<Box<dyn FrameSink>>,
    mic: Source,
    system: Source,
    levels: Arc<Levels>,
    live: Arc<LiveFeed>,
    shared: Arc<MixerShared>,
    live_resampler: Resampler,
    written: u64,
}

impl Mixer {
    fn new(
        writer: Box<dyn FrameSink>,
        mic: Source,
        system: Source,
        levels: Arc<Levels>,
        live: Arc<LiveFeed>,
        shared: Arc<MixerShared>,
    ) -> Mixer {
        Mixer {
            writer: Some(writer),
            mic,
            system,
            levels,
            live,
            shared,
            live_resampler: Resampler::new(RATE, LIVE_RATE),
            written: 0,
        }
    }

    fn run(mut self, stop: Arc<AtomicBool>) -> std::io::Result<f64> {
        match self.run_inner(&stop) {
            Ok(secs) => Ok(secs),
            Err(e) => {
                log::error!("the recording could not be written: {e}");
                *self.shared.failure.lock().unwrap() = Some(e.to_string());
                self.levels.set(0.0, 0.0);
                Err(e)
            }
        }
    }

    fn run_inner(&mut self, stop: &AtomicBool) -> std::io::Result<f64> {
        let started = Instant::now();
        let mut last_sync = Instant::now();
        let mut buffers = Frames::default();
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));
            self.mic.drain();
            self.system.drain();
            let behind = started.elapsed().saturating_sub(LATENCY);
            let target = (behind.as_secs_f64() * f64::from(RATE)) as u64;
            while self.written + FRAME as u64 <= target {
                self.frame(&mut buffers)?;
            }
            if last_sync.elapsed() >= Duration::from_secs(5) {
                self.writer.as_mut().expect("open").sync()?;
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
        let end = self.seconds();
        self.mic.close_gap(end, &self.shared.gaps);
        self.system.close_gap(end, &self.shared.gaps);
        self.levels.set(0.0, 0.0);
        self.writer.take().expect("open").finish()
    }

    fn seconds(&self) -> f64 {
        self.written as f64 / f64::from(RATE)
    }

    fn frame(&mut self, f: &mut Frames) -> std::io::Result<()> {
        let at = self.seconds();
        self.mic.note(at, &self.shared.gaps);
        self.system.note(at, &self.shared.gaps);
        self.mic.take(&mut f.mic);
        self.system.take(&mut f.system);
        for i in 0..FRAME {
            f.stereo[2 * i] = f.mic[i];
            f.stereo[2 * i + 1] = f.system[i];
        }
        self.writer.as_mut().expect("open").write_frame(&f.stereo)?;
        self.written += FRAME as u64;
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

    fn source(rate: u32, name: &'static str) -> (rtrb::Producer<f32>, Source, Arc<SourceShared>) {
        let (tx, rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
        let shared = SourceShared::new(rate);
        (tx, Source::new(rx, Some(shared.clone()), name), shared)
    }

    /// Writes `ok_frames` frames, then fails as a full disk does.
    struct FullDisk {
        ok_frames: usize,
        written: Arc<AtomicU32>,
    }

    impl FrameSink for FullDisk {
        fn write_frame(&mut self, _: &[f32]) -> std::io::Result<()> {
            if self.written.load(Ordering::SeqCst) as usize >= self.ok_frames {
                return Err(std::io::Error::from_raw_os_error(28));
            }
            self.written.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn sync(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn finish(self: Box<Self>) -> std::io::Result<f64> {
            Ok(0.0)
        }
    }

    #[test]
    fn meter_maps_dbfs_to_zero_one() {
        assert_eq!(meter(&[]), 0.0);
        assert_eq!(meter(&[0.0; 960]), 0.0);
        assert!((meter(&[1.0; 960]) - 1.0).abs() < 1e-6);
        assert!((meter(&[0.1; 960]) - 2.0 / 3.0).abs() < 1e-3);
    }

    #[test]
    fn a_source_far_ahead_is_trimmed_and_a_short_one_pads_silence() {
        let (mut tx, mut s, _) = source(RATE, "microphone");
        for _ in 0..RATE {
            tx.push(0.5).unwrap();
        }
        s.drain();
        assert_eq!(s.queue.len(), TRIM_TO);
        let mut frame = vec![1.0; FRAME];
        let (_tx2, mut empty, _) = source(RATE, "system_audio");
        empty.take(&mut frame);
        assert!(frame.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn a_write_error_stops_the_mixer_at_once_and_is_published() {
        let (_mtx, mic, _) = source(RATE, "microphone");
        let (_stx, sys, _) = source(RATE, "system_audio");
        let written = Arc::new(AtomicU32::new(0));
        let shared = Arc::new(MixerShared::default());
        let levels = Arc::new(Levels::default());
        let mixer = Mixer::new(
            Box::new(FullDisk { ok_frames: 5, written: written.clone() }),
            mic,
            sys,
            levels,
            Arc::new(LiveFeed::default()),
            shared.clone(),
        );
        let stop = Arc::new(AtomicBool::new(false));
        let t = Instant::now();
        let handle = std::thread::spawn({
            let stop = stop.clone();
            move || mixer.run(stop)
        });
        // The mixer ends by itself; nobody pressed Stop.
        let err = handle.join().unwrap().unwrap_err();
        assert!(t.elapsed() < Duration::from_secs(3));
        assert_eq!(err.raw_os_error(), Some(28));
        assert_eq!(written.load(Ordering::SeqCst), 5);
        assert!(shared.failure().unwrap().contains("No space left on device"));
        assert!(!stop.load(Ordering::SeqCst));
    }

    #[test]
    fn a_lost_source_leaves_a_gap_and_a_new_rate_is_followed() {
        let (mut mtx, mic, mic_shared) = source(RATE, "microphone");
        let (_stx, sys, _) = source(RATE, "system_audio");
        let dir = tempfile::tempdir().unwrap();
        let shared = Arc::new(MixerShared::default());
        let mut mixer = Mixer::new(
            Box::new(OggOpusWriter::create(&dir.path().join("g.ogg")).unwrap()),
            mic,
            sys,
            Arc::new(Levels::default()),
            Arc::new(LiveFeed::default()),
            shared.clone(),
        );
        let mut f = Frames::default();
        for _ in 0..50 {
            mixer.frame(&mut f).unwrap();
        }
        mic_shared.set_state(SourceState::Lost);
        for _ in 0..100 {
            mixer.frame(&mut f).unwrap();
        }
        // Back on a 16 kHz headset.
        mic_shared.set_state(SourceState::On);
        mic_shared.set_rate(16_000);
        for _ in 0..1600 {
            mtx.push(0.25).unwrap();
        }
        mixer.mic.drain();
        assert_eq!(mixer.mic.rate, 16_000);
        // 0.1 s at 16 kHz is 4,800 samples at 48 kHz, less the resampler's lookahead.
        assert!((mixer.mic.queue.len() as i64 - 4800).abs() < 100, "{}", mixer.mic.queue.len());
        mixer.frame(&mut f).unwrap();
        let gaps = shared.gaps.lock().unwrap().clone();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].source, "microphone");
        assert!((gaps[0].from_s - 1.0).abs() < 1e-9 && (gaps[0].to_s - 3.0).abs() < 1e-9, "{gaps:?}");
    }

    #[test]
    fn the_mixer_puts_the_microphone_left_and_the_system_right() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.ogg");
        let (mut mic_tx, mic, _) = source(44_100, "microphone");
        let (mut sys_tx, sys, _) = source(RATE, "system_audio");
        let live = Arc::new(LiveFeed::default());
        let (live_tx, mut live_rx) = rtrb::RingBuffer::<f32>::new(RING_SAMPLES);
        *live.sink.lock().unwrap() = Some(live_tx);
        live.enabled.store(true, Ordering::SeqCst);
        let levels = Arc::new(Levels::default());
        let mut mixer = Mixer::new(
            Box::new(OggOpusWriter::create(&path).unwrap()),
            mic,
            sys,
            levels.clone(),
            live,
            Arc::new(MixerShared::default()),
        );
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
        assert!((live_rx.slots() as i64 - 3_200).abs() < 40, "{}", live_rx.slots());
        let _ = live_rx.pop();
        let secs = mixer.writer.take().unwrap().finish().unwrap();
        assert!((secs - 0.22).abs() < 1e-6);
    }
}
