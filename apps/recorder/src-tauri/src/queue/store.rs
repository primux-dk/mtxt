//! The queue on disk: `recordings/<id>.ogg` and `recordings/<id>.json` under
//! the app's data directory.
//!
//! A state file is written to a temporary name, synced, renamed, and the
//! directory synced, so a crash never leaves half a file and a rename that
//! returned is on the disk. Loading hides nothing: a state file that does not
//! parse is a damaged entry, and audio without a state file is an orphan; both
//! are shown to the user, and neither is deleted here.

use super::chunks::hash_file;
use super::state::RecordingState;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

/// A state file that does not parse.
#[derive(Debug, Clone, PartialEq)]
pub struct Damaged {
    pub id: String,
    pub error: String,
    pub has_audio: bool,
}

/// Audio in the queue directory without a state file.
#[derive(Debug, Clone, PartialEq)]
pub struct Orphan {
    pub id: String,
    pub modified: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Default)]
pub struct Loaded {
    /// Newest first.
    pub recordings: Vec<RecordingState>,
    pub damaged: Vec<Damaged>,
    pub orphans: Vec<Orphan>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ExportError {
    /// The destination is the queue's own directory or one of its files.
    #[error("the destination is inside the recorder's queue")]
    InsideQueue,
    #[error("{0}")]
    Io(String),
    #[error("the copy does not match the original")]
    Mismatch,
}

impl Store {
    pub fn new(data_dir: &Path) -> std::io::Result<Store> {
        let dir = data_dir.join("recordings");
        fs::create_dir_all(&dir)?;
        Ok(Store { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn audio_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.ogg", safe(id)))
    }

    fn state_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", safe(id)))
    }

    pub fn save(&self, rec: &RecordingState) -> std::io::Result<()> {
        let path = self.state_path(&rec.id);
        let tmp = path.with_extension("json.tmp");
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(&serde_json::to_vec_pretty(rec).map_err(std::io::Error::other)?)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &path)?;
        sync_dir(&self.dir)
    }

    /// Every entry on disk. Recordings newest first.
    pub fn load_all(&self) -> Loaded {
        let mut out = Loaded::default();
        let Ok(entries) = fs::read_dir(&self.dir) else { return out };
        let mut states = std::collections::HashSet::new();
        let mut audio = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
            match path.extension().and_then(|e| e.to_str()) {
                Some("json") => {
                    states.insert(stem.clone());
                    match self.read(&stem) {
                        Ok(rec) => out.recordings.push(rec),
                        Err(error) => {
                            log::warn!("state file {} is damaged: {error}", path.display());
                            out.damaged.push(Damaged {
                                has_audio: self.audio_path(&stem).exists(),
                                id: stem,
                                error,
                            });
                        }
                    }
                }
                Some("ogg") => audio.push((stem, path)),
                _ => {}
            }
        }
        for (id, path) in audio {
            if states.contains(&id) {
                continue;
            }
            let modified = fs::metadata(&path)
                .and_then(|m| m.modified())
                .map(chrono::DateTime::<chrono::Utc>::from)
                .unwrap_or_else(|_| chrono::Utc::now());
            out.orphans.push(Orphan { id, modified });
        }
        out.recordings.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out.damaged.sort_by(|a, b| a.id.cmp(&b.id));
        out.orphans.sort_by(|a, b| b.modified.cmp(&a.modified));
        out
    }

    /// Read one state file again (Retry on a damaged entry).
    pub fn read(&self, id: &str) -> Result<RecordingState, String> {
        let bytes = fs::read(self.state_path(id)).map_err(|e| e.to_string())?;
        let rec: RecordingState = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if rec.id != id {
            return Err(format!("the file says id {}", rec.id));
        }
        Ok(rec)
    }

    /// Delete the audio. The state file stays as the record of what happened.
    pub fn delete_audio(&self, id: &str) -> std::io::Result<()> {
        match fs::remove_file(self.audio_path(id)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other.and_then(|_| sync_dir(&self.dir)),
        }
    }

    /// Remove both files; only for a recording established as empty, or whose audio is gone.
    pub fn forget(&self, id: &str) -> std::io::Result<()> {
        self.delete_audio(id)?;
        match fs::remove_file(self.state_path(id)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other.and_then(|_| sync_dir(&self.dir)),
        }
    }

    /// Copy the audio of `id` to `dest` for "Save elsewhere": refuse a
    /// destination in the queue, copy to a temporary name beside `dest`, sync
    /// it, check its SHA-256 against the original (and `expected`, when the
    /// state knows the hash), rename it into place and sync the directory.
    /// The queue's own copy is untouched; the caller removes it afterwards.
    pub fn export(&self, id: &str, dest: &Path, expected: Option<&str>) -> Result<String, ExportError> {
        let io = |e: std::io::Error| ExportError::Io(e.to_string());
        let src = self.audio_path(id);
        if self.is_inside(dest) {
            return Err(ExportError::InsideQueue);
        }
        let (source_hash, _) = hash_file(&src).map_err(io)?;
        if expected.is_some_and(|h| h != source_hash) {
            return Err(ExportError::Mismatch);
        }
        let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("recording.ogg");
        let tmp = parent.join(format!(".{name}.{}.part", uuid::Uuid::new_v4()));
        let result = (|| {
            fs::copy(&src, &tmp).map_err(io)?;
            fs::File::open(&tmp).and_then(|f| f.sync_all()).map_err(io)?;
            let (copy_hash, _) = hash_file(&tmp).map_err(io)?;
            if copy_hash != source_hash {
                return Err(ExportError::Mismatch);
            }
            fs::rename(&tmp, dest).map_err(io)?;
            sync_dir(parent).map_err(io)?;
            Ok(copy_hash)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }

    /// `path` is the queue directory, inside it, or one of its files, through
    /// any symlink.
    fn is_inside(&self, path: &Path) -> bool {
        let queue = fs::canonicalize(&self.dir).unwrap_or_else(|_| self.dir.clone());
        let resolved = fs::canonicalize(path).ok().or_else(|| {
            let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
            fs::canonicalize(parent).ok().map(|p| p.join(path.file_name().unwrap_or_default()))
        });
        match resolved {
            Some(p) => p.starts_with(&queue),
            None => true,
        }
    }
}

/// Make a rename or a removal in `dir` durable.
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

/// Ids are UUIDs made here; anything else is reduced to safe characters.
fn safe(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::state::{Event, Status};
    use chrono::{Duration, TimeZone, Utc};

    fn store() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path()).unwrap();
        (tmp, store)
    }

    #[test]
    fn the_queue_survives_a_restart() {
        let (tmp, store) = store();
        let t = Utc.with_ymd_and_hms(2026, 10, 23, 9, 0, 0).unwrap();
        let mut a = RecordingState::new("a".into(), "https://h.io".into(), "Første".into(), t);
        let b = RecordingState::new("b".into(), "https://h.io".into(), "Anden".into(), t + Duration::hours(1));
        a.apply(Event::Stopped { at: t, duration_s: 60, sha256: "00".into(), size_bytes: 10 }, t);
        store.save(&a).unwrap();
        store.save(&b).unwrap();
        let again = Store::new(tmp.path()).unwrap();
        let all = again.load_all();
        assert_eq!(all.recordings.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
        assert_eq!(all.recordings[1].status, Status::Uploading);
        assert!(again.audio_path("../x").ends_with("recordings/x.ogg"));
        assert!(!tmp.path().join("recordings/a.json.tmp").exists());
    }

    #[test]
    fn a_damaged_state_file_and_orphaned_audio_are_listed_and_kept() {
        let (tmp, store) = store();
        let dir = tmp.path().join("recordings");
        fs::write(dir.join("broken.json"), b"{").unwrap();
        fs::write(dir.join("broken.ogg"), b"OggS audio").unwrap();
        fs::write(dir.join("lost.ogg"), b"OggS audio").unwrap();
        let loaded = store.load_all();
        assert!(loaded.recordings.is_empty());
        assert_eq!(loaded.damaged.len(), 1);
        assert_eq!(loaded.damaged[0].id, "broken");
        assert!(loaded.damaged[0].has_audio);
        assert_eq!(loaded.orphans.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), vec!["lost"]);
        for f in ["broken.json", "broken.ogg", "lost.ogg"] {
            assert!(dir.join(f).exists(), "{f} was removed");
        }
        // Repaired by hand, the entry reads again.
        let rec = RecordingState::new("broken".into(), "h".into(), "t".into(), Utc::now());
        fs::write(dir.join("broken.json"), serde_json::to_vec(&rec).unwrap()).unwrap();
        assert_eq!(store.read("broken").unwrap().id, "broken");
    }

    #[test]
    fn export_refuses_the_queue_itself_and_keeps_the_source() {
        let (tmp, store) = store();
        let data = vec![7u8; 100_000];
        fs::write(store.audio_path("a"), &data).unwrap();
        fs::write(store.audio_path("b"), b"other").unwrap();
        let (hash, _) = hash_file(&store.audio_path("a")).unwrap();
        // The source itself, another queue file, the queue directory.
        assert_eq!(store.export("a", &store.audio_path("a"), Some(&hash)), Err(ExportError::InsideQueue));
        assert_eq!(store.export("a", &store.audio_path("b"), Some(&hash)), Err(ExportError::InsideQueue));
        assert_eq!(store.export("a", &store.dir().join("new.ogg"), Some(&hash)), Err(ExportError::InsideQueue));
        // Through a symlink to the queue directory.
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(store.dir(), &link).unwrap();
        assert_eq!(store.export("a", &link.join("a.ogg"), Some(&hash)), Err(ExportError::InsideQueue));
        assert_eq!(fs::read(store.audio_path("a")).unwrap(), data);
        assert_eq!(fs::read(store.audio_path("b")).unwrap(), b"other");
    }

    #[test]
    fn export_copies_checks_and_leaves_no_temporary_file() {
        let (_tmp, store) = store();
        let out = tempfile::tempdir().unwrap();
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 253) as u8).collect();
        fs::write(store.audio_path("a"), &data).unwrap();
        let (hash, _) = hash_file(&store.audio_path("a")).unwrap();
        let dest = out.path().join("Plan for november.ogg");
        assert_eq!(store.export("a", &dest, Some(&hash)).unwrap(), hash);
        assert_eq!(fs::read(&dest).unwrap(), data);
        assert_eq!(fs::read_dir(out.path()).unwrap().count(), 1);
        assert!(store.audio_path("a").exists(), "the caller removes the queue copy");
        // A source that no longer matches its recorded hash is not exported.
        assert_eq!(store.export("a", &out.path().join("x.ogg"), Some("00")), Err(ExportError::Mismatch));
    }
}
