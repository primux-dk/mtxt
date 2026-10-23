//! Opus in Ogg (RFC 7845), stereo at 48 kHz: microphone left, system audio
//! right. Pages are flushed every second, so a crash leaves a file that plays
//! up to the last second.

use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

pub const RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
/// 20 ms at 48 kHz.
pub const FRAME: usize = 960;
/// 48 kbit/s stereo: about 86 MB for four hours.
pub const BITRATE: i32 = 48_000;
const PACKETS_PER_PAGE: u32 = 50;
const VENDOR: &str = concat!("mtxt-recorder ", env!("CARGO_PKG_VERSION"));

pub struct OggOpusWriter {
    writer: PacketWriter<'static, BufWriter<File>>,
    encoder: opus::Encoder,
    serial: u32,
    pre_skip: u64,
    /// 48 kHz samples per channel encoded so far.
    samples: u64,
    packets_in_page: u32,
    out: Vec<u8>,
}

impl OggOpusWriter {
    pub fn create(path: &Path) -> std::io::Result<OggOpusWriter> {
        let file = File::create(path)?;
        let mut encoder = opus::Encoder::new(RATE, opus::Channels::Stereo, opus::Application::Voip)
            .map_err(std::io::Error::other)?;
        encoder.set_bitrate(opus::Bitrate::Bits(BITRATE)).map_err(std::io::Error::other)?;
        let pre_skip = encoder.get_lookahead().map_err(std::io::Error::other)?.max(0) as u64;
        let mut serial_bytes = [0u8; 4];
        let _ = getrandom::fill(&mut serial_bytes);
        let serial = u32::from_le_bytes(serial_bytes);
        let mut writer = PacketWriter::new(BufWriter::new(file));
        writer.write_packet(opus_head(pre_skip as u16), serial, PacketWriteEndInfo::EndPage, 0)?;
        writer.write_packet(opus_tags(), serial, PacketWriteEndInfo::EndPage, 0)?;
        writer.inner_mut().flush()?;
        Ok(OggOpusWriter { writer, encoder, serial, pre_skip, samples: 0, packets_in_page: 0, out: vec![0u8; 4000] })
    }

    /// One 20 ms frame, interleaved stereo: `FRAME * 2` samples.
    pub fn write_frame(&mut self, interleaved: &[f32]) -> std::io::Result<()> {
        debug_assert_eq!(interleaved.len(), FRAME * CHANNELS);
        let n = self.encoder.encode_float(interleaved, &mut self.out).map_err(std::io::Error::other)?;
        self.samples += FRAME as u64;
        self.packets_in_page += 1;
        let end = if self.packets_in_page >= PACKETS_PER_PAGE {
            self.packets_in_page = 0;
            PacketWriteEndInfo::EndPage
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        self.writer.write_packet(self.out[..n].to_vec(), self.serial, end, self.pre_skip + self.samples)?;
        if end == PacketWriteEndInfo::EndPage {
            self.writer.inner_mut().flush()?;
        }
        Ok(())
    }

    /// Seconds of audio written.
    pub fn duration_secs(&self) -> f64 {
        self.samples as f64 / f64::from(RATE)
    }

    /// Push buffered pages to the disk.
    pub fn sync(&mut self) -> std::io::Result<()> {
        self.writer.inner_mut().flush()?;
        self.writer.inner_mut().get_ref().sync_data()
    }

    /// End the stream: one silent frame carries the end-of-stream page.
    pub fn finish(mut self) -> std::io::Result<f64> {
        let silence = vec![0.0f32; FRAME * CHANNELS];
        let n = self.encoder.encode_float(&silence, &mut self.out).map_err(std::io::Error::other)?;
        self.samples += FRAME as u64;
        self.writer.write_packet(
            self.out[..n].to_vec(),
            self.serial,
            PacketWriteEndInfo::EndStream,
            self.pre_skip + self.samples,
        )?;
        let duration = self.duration_secs();
        let mut inner = self.writer.into_inner();
        inner.flush()?;
        inner.get_ref().sync_all()?;
        Ok(duration)
    }
}

fn opus_head(pre_skip: u16) -> Vec<u8> {
    let mut h = Vec::with_capacity(19);
    h.extend_from_slice(b"OpusHead");
    h.push(1); // version
    h.push(CHANNELS as u8);
    h.extend_from_slice(&pre_skip.to_le_bytes());
    h.extend_from_slice(&RATE.to_le_bytes());
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain
    h.push(0); // mapping family 0: mono or stereo
    h
}

fn opus_tags() -> Vec<u8> {
    let mut t = Vec::new();
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(VENDOR.len() as u32).to_le_bytes());
    t.extend_from_slice(VENDOR.as_bytes());
    let comments = ["CHANNEL_LEFT=microphone", "CHANNEL_RIGHT=system"];
    t.extend_from_slice(&(comments.len() as u32).to_le_bytes());
    for c in comments {
        t.extend_from_slice(&(c.len() as u32).to_le_bytes());
        t.extend_from_slice(c.as_bytes());
    }
    t
}

/// Seconds of audio in an Ogg Opus file, from the last page's granule
/// position and the header's pre-skip. Works on a file a crash cut short.
pub fn duration_of(path: &Path) -> std::io::Result<f64> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let mut head = [0u8; 64];
    let n = f.read(&mut head)?;
    let pre_skip = find(&head[..n], b"OpusHead")
        .map(|i| u16::from_le_bytes([head[i + 10], head[i + 11]]) as u64)
        .unwrap_or(0);
    let tail_len = len.min(256 * 1024);
    f.seek(SeekFrom::Start(len - tail_len))?;
    let mut tail = vec![0u8; tail_len as usize];
    f.read_exact(&mut tail)?;
    let mut granule = 0u64;
    let mut i = 0;
    while let Some(off) = find(&tail[i..], b"OggS") {
        let at = i + off;
        if at + 14 <= tail.len() {
            let g = u64::from_le_bytes(tail[at + 6..at + 14].try_into().unwrap());
            if g != u64::MAX {
                granule = g;
            }
        }
        i = at + 4;
    }
    Ok(granule.saturating_sub(pre_skip) as f64 / f64::from(RATE))
}

/// What a full read of a recording file found.
#[derive(Debug, Clone, PartialEq)]
pub struct Inspection {
    /// Opus packets after the two headers.
    pub audio_packets: u64,
    pub duration_s: f64,
}

/// Read the whole file through an Ogg reader. An I/O error is an error: the
/// caller keeps the file and says it could not be read. A damaged page at the
/// end (a crash in the middle of a write) ends the count without an error.
pub fn inspect(path: &Path) -> std::io::Result<Inspection> {
    let file = File::open(path)?;
    let mut reader = ogg::PacketReader::new(std::io::BufReader::new(file));
    let mut packets = 0u64;
    let mut pre_skip = 0u64;
    let mut granule = 0u64;
    loop {
        match reader.read_packet() {
            Ok(Some(p)) => {
                if packets == 0 && p.data.starts_with(b"OpusHead") && p.data.len() >= 12 {
                    pre_skip = u16::from_le_bytes([p.data[10], p.data[11]]) as u64;
                }
                if p.absgp_page() != u64::MAX {
                    granule = granule.max(p.absgp_page());
                }
                packets += 1;
            }
            Ok(None) => break,
            // A torn last page reads as an early end of file, not as a failed read.
            Err(ogg::OggReadError::ReadError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(ogg::OggReadError::ReadError(e)) => return Err(e),
            Err(e) => {
                log::warn!("{}: the Ogg stream ends in a damaged page: {e}", path.display());
                break;
            }
        }
    }
    Ok(Inspection { audio_packets: packets.saturating_sub(2), duration_s: granule.saturating_sub(pre_skip) as f64 / f64::from(RATE) })
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_stereo_ogg_opus_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.ogg");
        let mut w = OggOpusWriter::create(&path).unwrap();
        let mut frame = vec![0f32; FRAME * 2];
        for f in 0..150 {
            for i in 0..FRAME {
                let t = (f * FRAME + i) as f32 / RATE as f32;
                frame[2 * i] = (t * 440.0 * std::f32::consts::TAU).sin() * 0.3;
                frame[2 * i + 1] = (t * 660.0 * std::f32::consts::TAU).sin() * 0.3;
            }
            w.write_frame(&frame).unwrap();
        }
        assert!((w.duration_secs() - 3.0).abs() < 1e-9);
        let secs = w.finish().unwrap();
        assert!((secs - 3.02).abs() < 1e-9);

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"OggS");
        assert!(find(&bytes, b"OpusHead").is_some());
        assert!(find(&bytes, b"OpusTags").is_some());
        // 48 kbit/s for 3 s is about 18 kB.
        assert!(bytes.len() > 8_000 && bytes.len() < 40_000, "{}", bytes.len());
        assert!((duration_of(&path).unwrap() - 3.02).abs() < 1e-6);

        // Every packet reads back through an Ogg reader.
        let mut reader = ogg::PacketReader::new(std::io::Cursor::new(bytes));
        let mut packets = 0;
        let mut last_flagged_eos = false;
        while let Some(p) = reader.read_packet().unwrap() {
            packets += 1;
            last_flagged_eos = p.last_in_stream();
        }
        assert_eq!(packets, 2 + 151);
        assert!(last_flagged_eos);
    }

    #[test]
    fn a_file_cut_short_still_has_a_duration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cut.ogg");
        {
            let mut w = OggOpusWriter::create(&path).unwrap();
            for _ in 0..120 {
                w.write_frame(&vec![0.01f32; FRAME * 2]).unwrap();
            }
            w.sync().unwrap();
            // Dropped without finish(): what a crash leaves.
            std::mem::forget(w);
        }
        // Two full pages of 50 packets reached the disk.
        assert!((duration_of(&path).unwrap() - 2.0).abs() < 1e-6);
        let seen = inspect(&path).unwrap();
        assert_eq!(seen.audio_packets, 100);
        assert!((seen.duration_s - 2.0).abs() < 1e-6);
        // Half a page torn off the end still reads up to the damage.
        let len = std::fs::metadata(&path).unwrap().len();
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(len - 100).unwrap();
        assert_eq!(inspect(&path).unwrap().audio_packets, 50);
        // Headers only: no audio.
        let empty = dir.path().join("empty.ogg");
        OggOpusWriter::create(&empty).unwrap().sync().unwrap();
        assert_eq!(inspect(&empty).unwrap().audio_packets, 0);
        assert!(inspect(&dir.path().join("missing.ogg")).is_err());
    }
}
