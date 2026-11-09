//! Bounded credential-free MAIN-window session. A single worker owns one Store for
//! all windows; never install one disk owner per AppView. No writes from Drop.
use crate::notifications::store::{FileStore, Store};
use crate::{
    policy::{self, Result},
    window_geometry::{Geometry, Rect, Space},
};
use serde_json::{Value, json};
use std::{
    any::Any,
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub const MAX_WINDOWS: usize = 8;
pub const MAX_BYTES: usize = 16 * 1024;
pub const DEBOUNCE: Duration = Duration::from_millis(300);
pub const MAX_REVISION: u64 = 9_007_199_254_740_000;
const INVALID: &str = "window_state_invalid";

#[derive(Clone, Debug, PartialEq)]
pub struct MainWindow {
    pub window_key: String,
    pub connection_id: String,
    pub runtime_key: String,
    pub geometry: Geometry,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub revision: u64,
    pub windows: Vec<MainWindow>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Failure {
    Read,
    Write,
    Conflict,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum UnknownObservation {
    Candidate,
    Prior,
    Other,
}

fn identity(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
    {
        return Err(INVALID.into());
    }
    Ok(())
}
impl MainWindow {
    pub fn validate(&self) -> Result<()> {
        identity(&self.window_key)?;
        identity(&self.connection_id)?;
        identity(&self.runtime_key)?;
        self.geometry.normal.validate()?;
        Ok(())
    }
    fn value(&self) -> Value {
        let r = self.geometry.normal;
        json!({"windowKey": self.window_key, "connectionID": self.connection_id,
            "runtimeKey": self.runtime_key,
            "space": match self.geometry.space { Space::AppKitPoints => "appkit-points", Space::Win32Physical => "win32-physical" },
            "normalBounds": {"x":r.x,"y":r.y,"width":r.width,"height":r.height},
            "maximized":self.geometry.maximized,"fullscreen":self.geometry.fullscreen})
    }
    fn parse(v: &Value) -> Result<Self> {
        let fields = [
            "windowKey",
            "connectionID",
            "runtimeKey",
            "space",
            "normalBounds",
            "maximized",
            "fullscreen",
        ];
        policy::keys(v, &fields, &fields)?;
        let r = &v["normalBounds"];
        policy::keys(
            r,
            &["x", "y", "width", "height"],
            &["x", "y", "width", "height"],
        )?;
        let number = |key: &str| r[key].as_f64().ok_or(INVALID);
        let value = Self {
            window_key: policy::string(v, "windowKey")?.into(),
            connection_id: policy::string(v, "connectionID")?.into(),
            runtime_key: policy::string(v, "runtimeKey")?.into(),
            geometry: Geometry {
                space: match v["space"].as_str() {
                    Some("appkit-points") => Space::AppKitPoints,
                    Some("win32-physical") => Space::Win32Physical,
                    _ => return Err(INVALID.into()),
                },
                normal: Rect {
                    x: number("x")?,
                    y: number("y")?,
                    width: number("width")?,
                    height: number("height")?,
                },
                maximized: v["maximized"].as_bool().ok_or(INVALID)?,
                fullscreen: v["fullscreen"].as_bool().ok_or(INVALID)?,
            },
        };
        value.validate()?;
        Ok(value)
    }
}
impl Snapshot {
    pub fn value(&self) -> Result<Value> {
        if self.revision == 0
            || self.revision > MAX_REVISION
            || self.windows.is_empty()
            || self.windows.len() > MAX_WINDOWS
        {
            return Err(INVALID.into());
        }
        let mut keys = HashSet::new();
        for w in &self.windows {
            w.validate()?;
            if !keys.insert(&w.window_key) {
                return Err(INVALID.into());
            }
        }
        let v = json!({"schema":1,"revision":self.revision,"windows":self.windows.iter().map(MainWindow::value).collect::<Vec<_>>()});
        if serde_json::to_vec(&v).map_err(|_| INVALID)?.len() > MAX_BYTES {
            return Err(INVALID.into());
        }
        Ok(v)
    }
    pub fn parse(v: &Value) -> Result<Self> {
        policy::keys(
            v,
            &["schema", "revision", "windows"],
            &["schema", "revision", "windows"],
        )?;
        if v["schema"] != 1 {
            return Err(INVALID.into());
        }
        let rows = v["windows"].as_array().ok_or(INVALID)?;
        if rows.is_empty() || rows.len() > MAX_WINDOWS {
            return Err(INVALID.into());
        }
        let result = Self {
            revision: v["revision"].as_u64().filter(|r| *r > 0).ok_or(INVALID)?,
            windows: rows.iter().map(MainWindow::parse).collect::<Result<_>>()?,
        };
        result.value()?;
        Ok(result)
    }
}

/// Reuses the existing exclusive-lock / private-stage / atomic-replace / readback /
/// parent-fsync implementation, in a DIFFERENT granted directory from notifications.
struct Disk {
    store: Box<dyn Store>,
    file: PathBuf,
}
impl Disk {
    fn check(&self) -> Result<()> {
        Self::check_file(&self.file)?;
        Self::check_file(&self.file.with_extension("lock"))
    }
    fn check_file(path: &Path) -> Result<()> {
        let m = match std::fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("window_state_unavailable".into()),
        };
        if !m.is_file() || m.file_type().is_symlink() || m.len() > MAX_BYTES as u64 {
            return Err(INVALID.into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if m.mode() & 0o077 != 0 || m.nlink() != 1 {
                return Err(INVALID.into());
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err(INVALID.into());
            }
        }
        Ok(())
    }
}
impl Store for Disk {
    fn load(&mut self) -> Result<Option<Value>> {
        self.check()?;
        self.store.load()
    }
    fn commit(&mut self, next: &Value) -> Result<()> {
        self.check()?;
        self.store.commit(next)
    }
}

pub struct Owner {
    store: Box<dyn Store>,
    // Kept outside the Send Store: native pinned-directory grants may be UI-thread-only.
    _grant: Option<Box<dyn Any>>,
    prior: Option<Snapshot>,
    baseline: Option<Value>,
    loaded: bool,
    pending: Option<Snapshot>,
    deadline: Option<Instant>,
    restoring: bool,
    quitting: bool,
    failure: Option<Failure>,
}
impl Owner {
    /// Alternative for an existing grant that already owns/locks its FileStore and
    /// pins its parents. The verified directory MUST be the directory of that store.
    /// This is native-only, never a JS path/Store injection point.
    pub fn from_granted_store(directory: &Path, store: Box<dyn Store>) -> Result<Self> {
        if !directory.is_absolute()
            || directory.file_name().and_then(|n| n.to_str()) != Some("window-state")
        {
            return Err("window_state_private_directory_required".into());
        }
        Ok(Self::with_store(Box::new(Disk {
            store,
            file: directory.join("desktop-notification-receipts.json"),
        })))
    }
    /// Caller MUST supply its validated, ancestor-pinned app-private local leaf named
    /// `window-state` (0700/no ACL on Mac; protected current-user inherited DACL on Win).
    /// This method deliberately does not discover home, chmod, or mint another grant.
    /// Retain the existing grant here; open only on the owning storage worker.
    pub fn in_private_directory<G: Any>(directory: &Path, grant: G) -> Result<Self> {
        if !directory.is_absolute()
            || directory.file_name().and_then(|n| n.to_str()) != Some("window-state")
        {
            return Err("window_state_private_directory_required".into());
        }
        let store = FileStore::in_private_directory(directory)?;
        let disk = Disk {
            store: Box::new(store),
            file: directory.join("desktop-notification-receipts.json"),
        };
        let mut owner = Self::with_store(Box::new(disk));
        owner._grant = Some(Box::new(grant));
        Ok(owner)
    }
    fn with_store(store: Box<dyn Store>) -> Self {
        let mut owner = Self {
            store,
            _grant: None,
            prior: None,
            baseline: None,
            loaded: false,
            pending: None,
            deadline: None,
            restoring: true,
            quitting: false,
            failure: None,
        };
        let _ = owner.retry_read();
        owner
    }
    pub fn snapshot(&self) -> Result<Option<&Snapshot>> {
        if !self.loaded {
            return Err("window_state_read_required".into());
        }
        Ok(self.prior.as_ref())
    }
    pub fn failure(&self) -> Option<Failure> {
        self.failure
    }
    pub fn dirty(&self) -> bool {
        self.pending.is_some()
    }
    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    /// Explicit read retry only; never resets to empty on error. On success stale queued
    /// captures are discarded, not replayed against a newly-read revision.
    pub fn retry_read(&mut self) -> Result<()> {
        if self.failure == Some(Failure::Unknown) {
            return Err("window_state_commit_unknown".into());
        }
        let loaded = self.store.load().and_then(|v| {
            let parsed = v.as_ref().map(Snapshot::parse).transpose()?;
            Ok((v, parsed))
        });
        match loaded {
            Ok((value, parsed)) => {
                self.baseline = value;
                self.prior = parsed;
                self.loaded = true;
                self.pending = None;
                self.deadline = None;
                self.failure = None;
                Ok(())
            }
            Err(e) => {
                self.failure = Some(Failure::Read);
                self.deadline = None;
                Err(e)
            }
        }
    }
    pub fn finish_restore(&mut self) -> Result<()> {
        if !self.loaded || self.failure.is_some() {
            return Err("window_state_restore_unresolved".into());
        }
        self.restoring = false;
        Ok(())
    }
    pub fn freeze_restore(&mut self) {
        self.restoring = true;
        self.deadline = None;
    }
    /// Freeze BEFORE teardown removes the first window; flush only the complete capture
    /// already staged. Never persist the progressively shrinking set of quitting windows.
    pub fn freeze_quit(&mut self) {
        self.quitting = true;
        self.deadline = None;
    }
    pub fn cancel_quit(&mut self) {
        self.quitting = false;
    }
    /// A complete, native-owned MAIN-window catalog only, primary first. Any missing,
    /// failed or uncommitted identity must abort the entire capture at the caller.
    /// No Mini Chat DTO exists. An empty list is rejected (last-window close retains it).
    pub fn stage(
        &mut self,
        expected_revision: u64,
        windows: Vec<MainWindow>,
        now: Instant,
    ) -> Result<()> {
        if self.restoring || self.quitting || !self.loaded {
            return Err("window_state_frozen".into());
        }
        if matches!(
            self.failure,
            Some(Failure::Read | Failure::Conflict | Failure::Unknown)
        ) {
            return Err("window_state_retry_required".into());
        }
        let revision = self.prior.as_ref().map_or(0, |v| v.revision);
        if expected_revision != revision {
            return Err("window_state_conflict".into());
        }
        let next = Snapshot {
            revision: revision
                .checked_add(1)
                .filter(|r| *r <= MAX_REVISION)
                .ok_or(INVALID)?,
            windows,
        };
        if self.pending.as_ref() == Some(&next) {
            // A fresh complete capture after cancelled quit / completed restore may
            // re-arm a deliberately frozen timer. Ordinary duplicates never extend it.
            if self.deadline.is_none() && self.failure.is_none() {
                self.deadline = Some(now + DEBOUNCE);
            }
            return Ok(());
        }
        if self
            .prior
            .as_ref()
            .is_some_and(|p| p.windows == next.windows)
        {
            self.pending = None;
            self.deadline = None;
            return Ok(());
        }
        next.value()?;
        self.pending = Some(next);
        // A failed write is never retried by move/resize events or the next timer tick.
        self.deadline = if self.failure.is_none() {
            Some(now + DEBOUNCE)
        } else {
            None
        };
        Ok(())
    }
    pub fn flush_due(&mut self, now: Instant) -> Result<bool> {
        if self.restoring || self.quitting || self.deadline.is_none_or(|d| d > now) {
            return Ok(false);
        }
        self.flush()?;
        Ok(true)
    }
    /// Explicit close/quit barrier (also explicit write retry). Invoke on a storage
    /// worker and await its result before destructive native teardown, never in Drop.
    pub fn flush(&mut self) -> Result<()> {
        if self.restoring || !self.loaded {
            return Err("window_state_frozen".into());
        }
        if matches!(
            self.failure,
            Some(Failure::Read | Failure::Conflict | Failure::Unknown)
        ) {
            return Err("window_state_retry_required".into());
        }
        self.deadline = None;
        let Some(next) = self.pending.as_ref() else {
            return Ok(());
        };
        let value = next.value()?;
        match self.store.load() {
            Ok(actual) if actual == self.baseline => {}
            Ok(_) => {
                self.failure = Some(Failure::Conflict);
                return Err("window_state_conflict".into());
            }
            Err(e) => {
                self.failure = Some(Failure::Read);
                return Err(e);
            }
        }
        match self.store.commit(&value) {
            Ok(()) => {
                self.prior = self.pending.take();
                self.baseline = Some(value);
                self.failure = None;
                Ok(())
            }
            Err(e) => {
                self.failure = Some(if e == "notification_store_unknown" {
                    Failure::Unknown
                } else {
                    Failure::Write
                });
                Err(e)
            }
        }
    }
    /// Unknown writes remain sticky until a cold owner reopen. This is read-only
    /// evidence, NOT a durability ACK and NOT permission to retry/rollback a write.
    pub fn inspect_unknown(&mut self) -> Result<UnknownObservation> {
        if self.failure != Some(Failure::Unknown) {
            return Err("window_state_not_unknown".into());
        }
        let actual = self.store.load()?;
        if actual == self.pending.as_ref().map(Snapshot::value).transpose()? {
            Ok(UnknownObservation::Candidate)
        } else if actual == self.baseline {
            Ok(UnknownObservation::Prior)
        } else {
            Ok(UnknownObservation::Other)
        }
    }
}

#[cfg(test)]
#[path = "window_state_tests.rs"]
mod tests;
