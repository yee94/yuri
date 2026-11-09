//! Local config transactions: private staged files, exclusive OS lock, target CAS,
//! immutable backups, fsync-before-publication and durable, read-only run receipts.
use super::*;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Local {
    home: PathBuf,
    identity: String,
    home_key: String,
    #[cfg(test)]
    observer: Option<Arc<dyn Fn(Point) -> Result<()> + Send + Sync>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Point {
    Prepared,
    BeforeCas,
    Replaced(usize),
    ReceiptSynced,
}
struct TargetLock {
    file: File,
    reservation: Option<PathBuf>,
}
impl TargetLock {
    fn release(mut self) -> Result<()> {
        let path = self.reservation.take().ok_or(Error::Invalid)?;
        fs::remove_dir(&path).map_err(|_| Error::Storage)?;
        sync_dir(path.parent().ok_or(Error::Invalid)?)?;
        Ok(())
    }
}
impl Drop for TargetLock {
    fn drop(&mut self) {
        let _ = &self.file;
        if let Some(path) = self.reservation.take() {
            let _ = fs::remove_dir(&path);
        }
    }
}
impl Local {
    /// Native-only trusted home grant. No renderer path or fallback to process HOME.
    pub fn new(home: PathBuf, identity: String) -> Result<Self> {
        if !home.is_absolute()
            || !identifier(&identity)
            || home
                .components()
                .any(|v| matches!(v, Component::ParentDir | Component::CurDir))
        {
            return Err(Error::Invalid);
        }
        let home = fs::canonicalize(home).map_err(|_| Error::Storage)?;
        let metadata = fs::symlink_metadata(&home).map_err(|_| Error::Storage)?;
        if !metadata.is_dir() {
            return Err(Error::Invalid);
        }
        let home_key = stamp(&metadata, &[]);
        Ok(Self {
            home,
            identity,
            home_key,
            #[cfg(test)]
            observer: None,
        })
    }
    #[cfg(test)]
    pub fn observe(mut self, observer: Arc<dyn Fn(Point) -> Result<()> + Send + Sync>) -> Self {
        self.observer = Some(observer);
        self
    }
    fn point(&self, point: Point) -> Result<()> {
        #[cfg(test)]
        if let Some(observer) = &self.observer {
            return observer(point);
        }
        let _ = point;
        Ok(())
    }
    fn store(&self) -> PathBuf {
        self.home
            .join(".config/opencode/.yuri.sync-runs")
            .join(&self.identity)
    }
    fn reservation(&self) -> PathBuf {
        self.home.join(".config/opencode/.yuri.sync-target-lock")
    }
    fn check(&self, path: &Path) -> Result<()> {
        let home_meta = fs::metadata(&self.home).map_err(|_| Error::Storage)?;
        if home_identity(&home_meta) != self.home_key.split('|').next().unwrap_or("") {
            return Err(Error::Stale);
        }
        let relative = path.strip_prefix(&self.home).map_err(|_| Error::Invalid)?;
        let mut current = self.home.clone();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(Error::Invalid);
            };
            current.push(name);
            match fs::symlink_metadata(&current) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        return Err(Error::Invalid);
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::MetadataExt;
                        if meta.is_file() && meta.nlink() != 1 {
                            return Err(Error::Invalid);
                        }
                        let private = [
                            ".config/opencode/.yuri.sync-runs",
                            ".config/opencode/.yuri.sync-backup",
                            ".config/opencode/.yuri.sync-target-lock",
                            ".yuri.sync-backup-agents",
                        ]
                        .iter()
                        .any(|p| current.starts_with(self.home.join(p)));
                        if private
                            && meta.is_dir()
                            && (meta.uid() != effective_uid() || meta.mode() & 0o077 != 0)
                        {
                            return Err(Error::Invalid);
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) => return Err(Error::Storage),
            }
        }
        Ok(())
    }
    fn mkdir(&self, path: &Path) -> Result<()> {
        self.check(path)?;
        if path == self.home {
            return Ok(());
        }
        if let Some(parent) = path.parent() && !parent.exists() {
            self.mkdir(parent)?;
        }
        match make_dir(path) {
            Ok(()) => {
                sync_dir(path.parent().ok_or(Error::Invalid)?)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if !fs::metadata(path).map_err(|_| Error::Storage)?.is_dir() {
                    return Err(Error::Invalid);
                }
            }
            Err(_) => return Err(Error::Storage),
        }
        self.check(path)
    }
    fn lock(&self, create: bool) -> Result<Option<File>> {
        let store = self.home.join(".config/opencode/.yuri.sync-runs");
        if create {
            self.mkdir(&store)?;
        } else if !store.exists() {
            return Ok(None);
        }
        let path = store.join("owner.lock");
        self.check(&path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(create);
        private_options(&mut options);
        let file = match options.open(path) {
            Ok(file) => file,
            Err(e) if !create && e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::Storage),
        };
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => Error::Busy,
            _ => Error::Storage,
        })?;
        if create {
            sync_dir(&store)?;
        }
        Ok(Some(file))
    }
    fn target_lock(&self) -> Result<TargetLock> {
        let file = self.lock(true)?.ok_or(Error::Storage)?;
        let reservation = self.reservation();
        self.check(&reservation)?;
        make_dir(&reservation).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                Error::Busy
            } else {
                Error::Storage
            }
        })?;
        let guard = TargetLock {
            file,
            reservation: Some(reservation.clone()),
        };
        sync_dir(reservation.parent().ok_or(Error::Invalid)?)?;
        Ok(guard)
    }
    fn target_unknown(&self) -> Result<bool> {
        let root = self.home.join(".config/opencode/.yuri.sync-runs");
        self.check(&root)?;
        for entry in fs::read_dir(root).map_err(|_| Error::Storage)? {
            let entry = entry.map_err(|_| Error::Storage)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| Error::Invalid)?;
            if name == "owner.lock" {
                continue;
            }
            if !identifier(&name) {
                return Err(Error::Invalid);
            }
            self.check(&entry.path())?;
            let other = Self {
                identity: name,
                home: self.home.clone(),
                home_key: self.home_key.clone(),
                #[cfg(test)]
                observer: None,
            };
            if other
                .states()?
                .iter()
                .any(|v| matches!(v["phase"].as_str(), Some("applying" | "unknown")))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    fn bytes(&self, path: &Path) -> Result<(Vec<u8>, fs::Metadata)> {
        self.check(path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        no_follow(&mut options);
        let file = options.open(path).map_err(|_| Error::Storage)?;
        let before = file.metadata().map_err(|_| Error::Storage)?;
        if !before.is_file() || before.len() > MAX_BYTES as u64 {
            return Err(Error::Invalid);
        }
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Storage)?;
        let after = file.metadata().map_err(|_| Error::Storage)?;
        if bytes.len() > MAX_BYTES || stamp(&before, &[]) != stamp(&after, &[]) {
            return Err(Error::Stale);
        }
        Ok((bytes, after))
    }
    fn snapshot(&self, cancel: &Cancellation) -> Result<Vec<Entry>> {
        let mut entries = Vec::new();
        let config = self.home.join(".config/opencode");
        for name in CONFIG.into_iter().chain(SINGLE) {
            let path = config.join(name);
            self.check(&path)?;
            if path.try_exists().map_err(|_| Error::Storage)? {
                self.walk(&path, name, &mut entries, cancel)?;
            }
        }
        for (name, legacy) in DIRECTORIES {
            for name in std::iter::once(name).chain(legacy) {
                let path = config.join(name);
                self.check(&path)?;
                if path.try_exists().map_err(|_| Error::Storage)? {
                    self.walk(&path, name, &mut entries, cancel)?;
                }
            }
        }
        let agents = self.home.join(".agents");
        self.check(&agents)?;
        if agents.try_exists().map_err(|_| Error::Storage)? {
            self.walk(&agents, AGENTS, &mut entries, cancel)?;
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        validate(&entries)?;
        Ok(entries)
    }
    fn walk(
        &self,
        path: &Path,
        name: &str,
        entries: &mut Vec<Entry>,
        cancel: &Cancellation,
    ) -> Result<()> {
        cancel.check()?;
        self.check(path)?;
        let metadata = fs::symlink_metadata(path).map_err(|_| Error::Storage)?;
        if metadata.is_dir() {
            let name = format!("{}/", name.trim_end_matches('/'));
            if !allowed(&name) {
                return Err(Error::Invalid);
            }
            entries.push(Entry {
                name: name.clone(),
                content: Vec::new(),
                version: stamp(&metadata, &[]),
                mode: mode(&metadata, true),
            });
            let mut children = fs::read_dir(path)
                .map_err(|_| Error::Storage)?
                .collect::<std::io::Result<Vec<_>>>()
                .map_err(|_| Error::Storage)?;
            children.sort_by_key(|v| v.file_name());
            for child in children {
                let child_name = child
                    .file_name()
                    .into_string()
                    .map_err(|_| Error::Invalid)?;
                if excluded(&child_name) {
                    continue;
                }
                self.walk(
                    &child.path(),
                    &format!("{name}{child_name}"),
                    entries,
                    cancel,
                )?;
            }
        } else if metadata.is_file() {
            let (bytes, metadata) = self.bytes(path)?;
            entries.push(Entry {
                name: name.into(),
                version: stamp(&metadata, &bytes),
                content: bytes,
                mode: mode(&metadata, false),
            });
        } else {
            return Err(Error::Invalid);
        }
        if entries.len() > MAX_FILES
            || entries.iter().map(|v| v.content.len()).sum::<usize>() > MAX_BYTES
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    fn write_new(&self, path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
        self.check(path)?;
        self.mkdir(path.parent().ok_or(Error::Invalid)?)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        private_options(&mut options);
        let mut file = options.open(path).map_err(|_| Error::Storage)?;
        file.write_all(bytes).map_err(|_| Error::Storage)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(mode))
                .map_err(|_| Error::Storage)?;
        }
        let _ = mode;
        file.sync_all().map_err(|_| Error::Storage)?;
        sync_dir(path.parent().ok_or(Error::Invalid)?)
    }
    fn state_path(&self, run: &str) -> PathBuf {
        self.store().join(run).join("receipt.json")
    }
    fn state(&self, run: &str) -> Result<Option<Value>> {
        if !identifier(run) {
            return Err(Error::Invalid);
        }
        let path = self.state_path(run);
        self.check(&path)?;
        if !path.try_exists().map_err(|_| Error::Storage)? {
            return Ok(None);
        }
        let (bytes, _) = self.bytes(&path)?;
        if bytes.len() > 16384 {
            return Err(Error::Invalid);
        }
        let envelope: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)?;
        exact(&envelope, &["record", "sha256"])?;
        let record = envelope["record"].as_str().ok_or(Error::Invalid)?;
        if envelope["sha256"] != hash(record.as_bytes()) {
            return Err(Error::Invalid);
        }
        let state: Value = serde_json::from_str(record).map_err(|_| Error::Invalid)?;
        exact(
            &state,
            &[
                "schema",
                "runID",
                "identity",
                "fingerprint",
                "phase",
                "startedAt",
                "endedAt",
                "files",
                "bytes",
                "applied",
            ],
        )?;
        if state["schema"] != 1
            || state["runID"] != run
            || state["identity"] != self.identity
            || !matches!(
                state["phase"].as_str(),
                Some("prepared" | "applying" | "success" | "failure" | "unknown")
            )
            || !state["fingerprint"]
                .as_str()
                .is_some_and(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
            || !timestamp(&state["startedAt"])
            || (!state["endedAt"].is_null() && !timestamp(&state["endedAt"]))
            || !state["files"]
                .as_u64()
                .is_some_and(|v| v <= MAX_FILES as u64)
            || !state["bytes"]
                .as_u64()
                .is_some_and(|v| v <= MAX_BYTES as u64)
            || !state["applied"]
                .as_u64()
                .is_some_and(|v| v <= 2 * MAX_FILES as u64)
        {
            return Err(Error::Invalid);
        }
        Ok(Some(state))
    }
    fn publish(&self, run: &str, state: &Value) -> Result<()> {
        let final_path = self.state_path(run);
        let temporary = final_path.with_extension("next");
        let record = serde_json::to_string(state).map_err(|_| Error::Invalid)?;
        let envelope = json!({"sha256":hash(record.as_bytes()),"record":record});
        self.write_new(
            &temporary,
            &serde_json::to_vec(&envelope).map_err(|_| Error::Invalid)?,
            0o600,
        )?;
        self.check(&final_path)?;
        fs::rename(&temporary, &final_path).map_err(|_| Error::SyncUnknown)?;
        sync_dir(final_path.parent().ok_or(Error::Invalid)?).map_err(|_| Error::SyncUnknown)
    }
    fn states(&self) -> Result<Vec<Value>> {
        let root = self.store();
        if !root.try_exists().map_err(|_| Error::Storage)? {
            return Ok(Vec::new());
        }
        self.check(&root)?;
        let mut states = Vec::new();
        for entry in fs::read_dir(root).map_err(|_| Error::Storage)? {
            let entry = entry.map_err(|_| Error::Storage)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| Error::Invalid)?;
            if name == "owner.lock" {
                continue;
            }
            if !identifier(&name) || !entry.file_type().map_err(|_| Error::Storage)?.is_dir() {
                return Err(Error::Invalid);
            }
            let state = self.state(&name)?.ok_or(Error::SyncUnknown)?;
            states.push(state);
            if states.len() > 4096 {
                return Err(Error::Busy);
            }
        }
        states.sort_by(|a, b| b["startedAt"].as_str().cmp(&a["startedAt"].as_str()));
        Ok(states)
    }
    fn backup_path(&self, run: &str, agents: bool) -> PathBuf {
        let root = if agents {
            self.home.join(".yuri.sync-backup-agents")
        } else {
            self.home.join(".config/opencode/.yuri.sync-backup")
        };
        root.join(format!("{}-{}-{run}", self.identity.len(), self.identity))
    }
    fn backups(&self, run: &str, before: &[Entry], after: &[Entry]) -> Result<()> {
        self.mkdir(&self.backup_path(run, false))?;
        self.mkdir(&self.backup_path(run, true))?;
        let manifest=before.iter().map(|e|json!({"name":e.name,"mode":e.mode,"version":e.version,"sha256":hash(&e.content)})).collect::<Vec<_>>();
        self.write_new(
            &self.store().join(run).join("backup-manifest.json"),
            &serde_json::to_vec(&manifest).map_err(|_| Error::Invalid)?,
            0o600,
        )?;
        for entry in before {
            if after
                .iter()
                .any(|v| v.name == entry.name && v.content == entry.content && v.mode == entry.mode)
            {
                continue;
            }
            let agents = entry.name.trim_end_matches('/').starts_with(AGENTS);
            let rel = if agents {
                entry
                    .name
                    .trim_end_matches('/')
                    .strip_prefix("@agents")
                    .unwrap_or("")
                    .trim_start_matches('/')
            } else {
                entry.name.trim_end_matches('/')
            };
            let path =
                self.backup_path(run, agents)
                    .join(if rel.is_empty() { "agents" } else { rel });
            if entry.directory() {
                self.mkdir(&path)?;
            } else {
                self.write_new(&path, &entry.content, entry.mode)?;
            }
        }
        Ok(())
    }
    fn prune(&self, current: &str) -> Result<()> {
        for agents in [false, true] {
            let root = self
                .backup_path("unused", agents)
                .parent()
                .ok_or(Error::Invalid)?
                .to_owned();
            self.check(&root)?;
            if !root.exists() {
                continue;
            }
            let mut generations = Vec::new();
            for state in self.states()? {
                if state["runID"] == current
                    || matches!(state["phase"].as_str(), Some("success" | "failure"))
                {
                    let run = state["runID"].as_str().ok_or(Error::Invalid)?;
                    let path = self.backup_path(run, agents);
                    if path.exists() {
                        generations.push(path);
                    }
                }
            }
            for path in generations.into_iter().skip(5) {
                self.remove_private_tree(&path)?;
            }
            sync_dir(&root)?;
        }
        Ok(())
    }
    fn remove_private_tree(&self, path: &Path) -> Result<()> {
        self.check(path)?;
        for entry in fs::read_dir(path).map_err(|_| Error::Storage)? {
            let entry = entry.map_err(|_| Error::Storage)?;
            self.check(&entry.path())?;
            if entry.file_type().map_err(|_| Error::Storage)?.is_dir() {
                self.remove_private_tree(&entry.path())?;
            } else {
                fs::remove_file(entry.path()).map_err(|_| Error::Storage)?;
            }
        }
        fs::remove_dir(path).map_err(|_| Error::Storage)
    }
}
impl Endpoint for Local {
    fn read(&self, cancel: &Cancellation) -> Result<Vec<Entry>> {
        self.snapshot(cancel)
    }
    fn replace(
        &self,
        run: &str,
        before: &[Entry],
        after: &[Entry],
        cancel: &Cancellation,
    ) -> Result<()> {
        if !identifier(run) {
            return Err(Error::Invalid);
        }
        validate(before)?;
        validate(after)?;
        cancel.check()?;
        let lock = self.target_lock()?;
        let fingerprint = hash(format!("{}:{}", signature(before), signature(after)).as_bytes());
        if let Some(state) = self.state(run)? {
            return if state["fingerprint"] != fingerprint {
                Err(Error::Invalid)
            } else if state["phase"] == "success" {
                Ok(())
            } else if state["phase"] == "failure" {
                Err(Error::Stale)
            } else {
                Err(Error::SyncUnknown)
            };
        }
        let states = self.states()?;
        if states.len() >= 4096 {
            return Err(Error::Busy);
        }
        if self.target_unknown()? {
            return Err(Error::SyncUnknown);
        }
        let run_dir = self.store().join(run);
        self.mkdir(&run_dir)?;
        let mut state = json!({"schema":1,"runID":run,"identity":self.identity,"fingerprint":fingerprint,"phase":"prepared","startedAt":time(),"endedAt":Value::Null,"files":after.len(),"bytes":after.iter().map(|v|v.content.len()).sum::<usize>(),"applied":0});
        self.publish(run, &state)?;
        let prepared = (|| {
            self.point(Point::Prepared)?;
            self.point(Point::BeforeCas)?;
            cancel.check()?;
            if !same(&self.snapshot(cancel)?, before) {
                return Err(Error::Stale);
            }
            self.backups(run, before, after)?;
            let stage = run_dir.join("stage");
            self.mkdir(&stage)?;
            for (index, entry) in after.iter().enumerate() {
                if !entry.directory()
                    && !before.iter().any(|v| {
                        v.name == entry.name && v.content == entry.content && v.mode == entry.mode
                    })
                {
                    self.write_new(&stage.join(index.to_string()), &entry.content, entry.mode)?;
                }
            }
            cancel.check()?;
            if !same(&self.snapshot(cancel)?, before) {
                return Err(Error::Stale);
            }
            Ok(stage)
        })();
        let stage = match prepared {
            Ok(stage) => stage,
            Err(error) => {
                state["phase"] = json!("failure");
                state["endedAt"] = json!(time());
                self.publish(run, &state).map_err(|_| Error::SyncUnknown)?;
                return Err(error);
            }
        };
        state["phase"] = json!("applying");
        self.publish(run, &state)?;
        let mut applied = 0;
        let mut uncertain = false;
        let result = (|| {
            let mut directories = after.iter().filter(|v| v.directory()).collect::<Vec<_>>();
            directories.sort_by_key(|v| v.name.len());
            for entry in directories {
                cancel.check()?;
                let path = home_path(&self.home, &entry.name)?;
                if !path.try_exists().map_err(|_| Error::Storage)? {
                    uncertain = true;
                }
                self.mkdir(&path)?;
            }
            for (index, entry) in after.iter().enumerate() {
                if entry.directory()
                    || before.iter().any(|v| {
                        v.name == entry.name && v.content == entry.content && v.mode == entry.mode
                    })
                {
                    continue;
                }
                cancel.check()?;
                let target = home_path(&self.home, &entry.name)?;
                self.check(&target)?;
                self.mkdir(target.parent().ok_or(Error::Invalid)?)?;
                if let Some(prior) = before.iter().find(|v| v.name == entry.name) {
                    let (bytes, metadata) = self.bytes(&target)?;
                    if stamp(&metadata, &bytes) != prior.version {
                        return Err(Error::Stale);
                    }
                } else if target.try_exists().map_err(|_| Error::Storage)? {
                    return Err(Error::Stale);
                }
                uncertain = true;
                fs::rename(stage.join(index.to_string()), &target).map_err(|_| Error::Storage)?;
                applied += 1;
                sync_dir(target.parent().ok_or(Error::Invalid)?)?;
                self.point(Point::Replaced(applied))?;
            }
            let mut deleted = before
                .iter()
                .filter(|v| !after.iter().any(|a| a.name == v.name))
                .collect::<Vec<_>>();
            deleted.sort_by_key(|v| std::cmp::Reverse(v.name.len()));
            for entry in deleted {
                cancel.check()?;
                let path = home_path(&self.home, &entry.name)?;
                self.check(&path)?;
                if entry.directory() {
                    uncertain = true;
                    match fs::remove_dir(&path) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => continue,
                        Err(_) => return Err(Error::Storage),
                    }
                } else {
                    let (bytes, metadata) = self.bytes(&path)?;
                    if stamp(&metadata, &bytes) != entry.version {
                        return Err(Error::Stale);
                    }
                    uncertain = true;
                    fs::remove_file(&path).map_err(|_| Error::Storage)?;
                }
                applied += 1;
                sync_dir(path.parent().ok_or(Error::Invalid)?)?;
                self.point(Point::Replaced(applied))?;
            }
            let mut directories = after.iter().filter(|v| v.directory()).collect::<Vec<_>>();
            directories.sort_by_key(|v| std::cmp::Reverse(v.name.len()));
            for entry in directories {
                cancel.check()?;
                let path = home_path(&self.home, &entry.name)?;
                self.check(&path)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if fs::metadata(&path)
                        .map_err(|_| Error::Storage)?
                        .permissions()
                        .mode()
                        & 0o777
                        != entry.mode
                    {
                        uncertain = true;
                        fs::set_permissions(&path, fs::Permissions::from_mode(entry.mode))
                            .map_err(|_| Error::Storage)?;
                        sync_dir(&path)?;
                    }
                }
            }
            Ok(())
        })();
        if result.is_ok() {
            self.prune(run).map_err(|_| Error::SyncUnknown)?;
        }
        state["applied"] = json!(applied);
        state["endedAt"] = json!(time());
        state["phase"] = json!(if result.is_ok() {
            "success"
        } else if !uncertain {
            "failure"
        } else {
            "unknown"
        });
        self.publish(run, &state).map_err(|_| Error::SyncUnknown)?;
        if result.is_ok() {
            self.point(Point::ReceiptSynced)
                .map_err(|_| Error::SyncUnknown)?;
            lock.release().map_err(|_| Error::SyncUnknown)?;
            Ok(())
        } else if uncertain {
            Err(Error::SyncUnknown)
        } else {
            result
        }
    }
    fn receipt(&self, run: &str) -> Result<Option<bool>> {
        let _lock = match self.lock(false) {
            Ok(Some(lock)) => lock,
            Ok(None) => return Ok(None),
            Err(Error::Busy) => return Ok(None),
            Err(e) => return Err(e),
        };
        let state = self.state(run)?;
        self.check(&self.reservation())?;
        let idle = !self
            .reservation()
            .try_exists()
            .map_err(|_| Error::Storage)?;
        Ok(state.and_then(|v| match v["phase"].as_str() {
            Some("success") => Some(true),
            Some("failure") => Some(false),
            Some("prepared") if idle => Some(false),
            _ => None,
        }))
    }
    fn history(&self) -> Result<Vec<Value>> {
        Ok(self
            .states()?
            .into_iter()
            .map(|mut v| {
                v.as_object_mut().unwrap().remove("identity");
                v.as_object_mut().unwrap().remove("fingerprint");
                v
            })
            .collect())
    }
}
fn time() -> String {
    format!(
        "{:020}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}
fn timestamp(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|v| (20..=39).contains(&v.len()) && v.bytes().all(|c| c.is_ascii_digit()))
}
#[cfg(unix)]
fn effective_uid() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() }
}
fn make_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}
fn home_identity(meta: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", meta.dev(), meta.ino())
    }
    #[cfg(not(unix))]
    {
        format!("{:?}", meta.created().ok())
    }
}
fn stamp(meta: &fs::Metadata, bytes: &[u8]) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        home_identity(meta),
        meta.len(),
        meta.modified()
            .ok()
            .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |v| v.as_nanos()),
        mode(meta, meta.is_dir()),
        hash(bytes)
    )
}
fn mode(meta: &fs::Metadata, _directory: bool) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        if _directory { 0o700 } else { 0o600 }
    }
}
fn private_options(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    no_follow(options);
}
fn no_follow(options: &mut OpenOptions) {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20000);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
}
fn sync_dir(path: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x02000000);
    }
    options
        .open(path)
        .and_then(|v| v.sync_all())
        .map_err(|_| Error::Storage)
}
