//! The queue on disk: `recordings/<id>.ogg` and `recordings/<id>.json` under
//! the app's data directory. A state file is written to a temporary name and
//! renamed, so a crash never leaves half a file.

use super::state::RecordingState;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
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
        fs::rename(&tmp, &path)
    }

    /// Every recording on disk, newest first. A state file that does not parse
    /// is left where it is and logged, never deleted.
    pub fn load_all(&self) -> Vec<RecordingState> {
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(&self.dir) else { return out };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match fs::read(&path).map_err(|e| e.to_string()).and_then(|b| {
                serde_json::from_slice::<RecordingState>(&b).map_err(|e| e.to_string())
            }) {
                Ok(rec) => out.push(rec),
                Err(e) => log::warn!("state file {} is unreadable: {e}", path.display()),
            }
        }
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    /// Delete the audio. The state file stays as the record of what happened.
    pub fn delete_audio(&self, id: &str) -> std::io::Result<()> {
        match fs::remove_file(self.audio_path(id)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    /// Remove both files; only for a recording whose audio is already gone.
    pub fn forget(&self, id: &str) -> std::io::Result<()> {
        self.delete_audio(id)?;
        match fs::remove_file(self.state_path(id)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
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

    #[test]
    fn the_queue_survives_a_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path()).unwrap();
        let t = Utc.with_ymd_and_hms(2026, 10, 23, 9, 0, 0).unwrap();
        let mut a = RecordingState::new("a".into(), "https://h.io".into(), "Første".into(), t);
        let b = RecordingState::new("b".into(), "https://h.io".into(), "Anden".into(), t + Duration::hours(1));
        a.apply(Event::Stopped { at: t, duration_s: 60, sha256: "00".into(), size_bytes: 10 }, t);
        store.save(&a).unwrap();
        store.save(&b).unwrap();
        fs::write(tmp.path().join("recordings/broken.json"), b"{").unwrap();

        let again = Store::new(tmp.path()).unwrap();
        let all = again.load_all();
        assert_eq!(all.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
        assert_eq!(all[1].status, Status::Uploading);
        assert!(tmp.path().join("recordings/broken.json").exists());
        assert!(again.audio_path("a").ends_with("recordings/a.ogg"));
        assert!(again.audio_path("../x").ends_with("recordings/x.ogg"));
    }
}
