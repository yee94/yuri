use super::*;
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

fn window(key: &str) -> MainWindow {
    MainWindow {
        window_key: key.into(),
        connection_id: "connection-public-1".into(),
        runtime_key: "runtime-public-1".into(),
        geometry: Geometry {
            space: Space::AppKitPoints,
            normal: Rect {
                x: 100.,
                y: 120.,
                width: 1200.,
                height: 800.,
            },
            maximized: false,
            fullscreen: false,
        },
    }
}
struct Directory {
    root: PathBuf,
    leaf: PathBuf,
}
impl Directory {
    fn new() -> Self {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("nsh-window-state-{}", crate::vault::id().unwrap()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            fs::DirBuilder::new()
                .mode(0o700)
                .create(root.join("window-state"))
                .unwrap();
        }
        #[cfg(windows)]
        {
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("window-state")).unwrap();
        }
        Self {
            leaf: root.join("window-state"),
            root,
        }
    }
    fn open(&self) -> Owner {
        Owner::in_private_directory(&self.leaf, ()).unwrap()
    }
    fn file(&self) -> PathBuf {
        self.leaf.join("desktop-notification-receipts.json")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        for item in fs::read_dir(&self.leaf).unwrap() {
            let p = item.unwrap().path();
            assert!(
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("desktop-notification-receipts")
            );
            fs::remove_file(p).unwrap();
        }
        fs::remove_dir(&self.leaf).unwrap();
        fs::remove_dir(&self.root).unwrap();
    }
}
fn ready(d: &Directory) -> Owner {
    let mut o = d.open();
    o.finish_restore().unwrap();
    o
}
fn revision(o: &Owner) -> u64 {
    o.snapshot().unwrap().map_or(0, |s| s.revision)
}

#[test]
fn actual_disk_two_windows_cold_restore_exact_whitelist_and_permissions() {
    let d = Directory::new();
    let mut o = ready(&d);
    assert!(
        Owner::in_private_directory(&d.leaf, ()).is_err(),
        "one process-wide lock, not per-window"
    );
    o.stage(
        0,
        vec![window("primary"), window("secondary")],
        Instant::now(),
    )
    .unwrap();
    o.flush().unwrap();
    let expected = o.snapshot().unwrap().unwrap().clone();
    drop(o);
    let o = d.open();
    assert_eq!(o.snapshot().unwrap(), Some(&expected));
    let v: Value = serde_json::from_slice(&fs::read(d.file()).unwrap()).unwrap();
    assert_eq!(v.as_object().unwrap().len(), 3);
    assert_eq!(v["windows"][0].as_object().unwrap().len(), 7);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(d.file()).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
#[test]
fn events_debounce_noop_freezes_and_last_window_close_preserve_prior() {
    let d = Directory::new();
    let mut o = d.open();
    let now = Instant::now();
    assert!(o.stage(0, vec![window("primary")], now).is_err());
    o.finish_restore().unwrap();
    o.stage(0, vec![window("primary")], now).unwrap();
    let mut moved = window("primary");
    moved.geometry.normal.x = 200.;
    o.stage(0, vec![moved.clone()], now + Duration::from_millis(100))
        .unwrap();
    assert!(!o.flush_due(now + Duration::from_millis(350)).unwrap());
    assert!(o.flush_due(now + Duration::from_millis(400)).unwrap());
    assert_eq!(revision(&o), 1);
    o.stage(1, vec![moved.clone()], now).unwrap();
    assert!(!o.dirty());
    assert!(o.stage(1, vec![], now).is_err());
    assert_eq!(revision(&o), 1);
    moved.geometry.normal.y = 400.;
    o.stage(1, vec![moved], now).unwrap();
    o.freeze_quit();
    assert!(o.stage(1, vec![window("primary")], now).is_err());
    assert!(!o.flush_due(now + DEBOUNCE).unwrap());
    o.flush().unwrap();
    assert_eq!(revision(&o), 2);
    o.cancel_quit();
    o.freeze_restore();
    assert!(o.flush().is_err());
}
#[test]
fn malformed_unknown_fields_duplicate_ids_and_capacity_never_partially_adopted() {
    let base = Snapshot {
        revision: 1,
        windows: vec![window("primary")],
    }
    .value()
    .unwrap();
    for key in ["token", "nativeWindowID", "auth", "route", "messages"] {
        let mut v = base.clone();
        v["windows"][0][key] = json!("forbidden");
        assert!(Snapshot::parse(&v).is_err());
    }
    for id in [
        "https://server.invalid?token=x",
        "has whitespace",
        "",
        "bad/identity",
    ] {
        let mut w = window("primary");
        w.runtime_key = id.into();
        assert!(w.validate().is_err());
    }
    assert!(
        Snapshot {
            revision: 1,
            windows: vec![window("same"), window("same")]
        }
        .value()
        .is_err()
    );
    assert!(
        Snapshot {
            revision: 1,
            windows: (0..=MAX_WINDOWS)
                .map(|i| window(&format!("w{i}")))
                .collect()
        }
        .value()
        .is_err()
    );
    let mut broken = base.clone();
    broken["windows"][0]["normalBounds"]["width"] = json!(-1);
    assert!(Snapshot::parse(&broken).is_err());
    let d = Directory::new();
    fs::write(d.file(), b"{truncated").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(d.file(), fs::Permissions::from_mode(0o600)).unwrap();
    }
    let mut o = d.open();
    assert!(o.snapshot().is_err());
    assert_eq!(o.failure(), Some(Failure::Read));
    assert!(o.finish_restore().is_err());
    assert!(o.flush().is_err());
    assert_eq!(fs::read(d.file()).unwrap(), b"{truncated");
    fs::write(d.file(), serde_json::to_vec(&base).unwrap()).unwrap();
    o.retry_read().unwrap();
    assert_eq!(revision(&o), 1);
}
#[test]
fn stale_revision_and_external_disk_conflict_retain_prior_and_candidate_until_explicit_read() {
    let d = Directory::new();
    let mut o = ready(&d);
    o.stage(0, vec![window("primary")], Instant::now()).unwrap();
    o.flush().unwrap();
    assert!(o.stage(0, vec![window("second")], Instant::now()).is_err());
    o.stage(1, vec![window("second")], Instant::now()).unwrap();
    let external = Snapshot {
        revision: 2,
        windows: vec![window("external")],
    }
    .value()
    .unwrap();
    fs::write(d.file(), serde_json::to_vec(&external).unwrap()).unwrap();
    assert!(o.flush().is_err());
    assert_eq!(o.failure(), Some(Failure::Conflict));
    assert_eq!(revision(&o), 1);
    assert!(o.dirty());
    assert!(!o.flush_due(Instant::now() + DEBOUNCE).unwrap());
    assert!(o.flush().is_err());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(d.file()).unwrap()).unwrap(),
        external
    );
    o.retry_read().unwrap();
    assert_eq!(revision(&o), 2);
    assert!(!o.dirty());
}

// Fault injection wraps the REAL transactional disk, never substitutes an in-memory
// fake for filesystem behavior. mode 1 fails before commit; 2 commits then loses ACK.
struct FaultDisk {
    disk: FileStore,
    mode: Arc<AtomicUsize>,
    writes: Arc<AtomicUsize>,
}
impl Store for FaultDisk {
    fn load(&mut self) -> Result<Option<Value>> {
        self.disk.load()
    }
    fn commit(&mut self, next: &Value) -> Result<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        match self.mode.load(Ordering::SeqCst) {
            1 => Err("synthetic_precommit_failure".into()),
            2 => {
                self.disk.commit(next)?;
                Err("notification_store_unknown".into())
            }
            3 => Err("notification_store_unknown".into()),
            _ => self.disk.commit(next),
        }
    }
}
#[test]
fn known_failed_write_preserves_disk_and_only_explicit_flush_retries() {
    let d = Directory::new();
    let mode = Arc::new(AtomicUsize::new(1));
    let writes = Arc::new(AtomicUsize::new(0));
    let mut o = Owner::with_store(Box::new(FaultDisk {
        disk: FileStore::in_private_directory(&d.leaf).unwrap(),
        mode: mode.clone(),
        writes: writes.clone(),
    }));
    o.finish_restore().unwrap();
    let now = Instant::now();
    o.stage(0, vec![window("primary")], now).unwrap();
    assert!(o.flush_due(now + DEBOUNCE).is_err());
    assert!(!d.file().exists());
    assert!(o.dirty());
    assert_eq!(revision(&o), 0);
    mode.store(0, Ordering::SeqCst);
    o.stage(0, vec![window("second")], now).unwrap();
    assert!(!o.flush_due(now + DEBOUNCE * 2).unwrap());
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    o.flush().unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 2);
    assert_eq!(revision(&o), 1);
}
#[test]
fn bounded_eight_window_duplicate_event_burst_does_not_defer_or_multiply_disk_writes() {
    let d = Directory::new();
    let writes = Arc::new(AtomicUsize::new(0));
    let mut o = Owner::with_store(Box::new(FaultDisk {
        disk: FileStore::in_private_directory(&d.leaf).unwrap(),
        mode: Arc::new(AtomicUsize::new(0)),
        writes: writes.clone(),
    }));
    o.finish_restore().unwrap();
    let now = Instant::now();
    let rows: Vec<_> = (0..MAX_WINDOWS)
        .map(|i| window(&format!("main-{i}")))
        .collect();
    o.stage(0, rows.clone(), now).unwrap();
    let deadline = o.deadline();
    for i in 1..=10_000 {
        o.stage(0, rows.clone(), now + Duration::from_millis(i))
            .unwrap();
    }
    assert_eq!(o.deadline(), deadline);
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    assert!(o.flush_due(now + DEBOUNCE).unwrap());
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    for _ in 0..100 {
        assert!(!o.flush_due(now + DEBOUNCE).unwrap());
    }
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}
#[cfg(unix)]
#[test]
fn actual_filesystem_stage_denial_preserves_prior_bytes_and_explicit_retry_commits() {
    use std::os::unix::fs::PermissionsExt;
    let d = Directory::new();
    let mut o = ready(&d);
    o.stage(0, vec![window("primary")], Instant::now()).unwrap();
    o.flush().unwrap();
    let prior = fs::read(d.file()).unwrap();
    o.stage(1, vec![window("second")], Instant::now()).unwrap();
    fs::set_permissions(&d.leaf, fs::Permissions::from_mode(0o500)).unwrap();
    let failed = o.flush();
    fs::set_permissions(&d.leaf, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(failed.is_err());
    assert_eq!(o.failure(), Some(Failure::Write));
    assert_eq!(fs::read(d.file()).unwrap(), prior);
    assert_eq!(revision(&o), 1);
    assert!(o.dirty());
    assert!(!o.flush_due(Instant::now() + DEBOUNCE).unwrap());
    o.flush().unwrap();
    assert_eq!(revision(&o), 2);
}
#[test]
fn unknown_after_atomic_replace_is_sticky_inspect_only_then_cold_recovery_without_replay() {
    let d = Directory::new();
    let mode = Arc::new(AtomicUsize::new(2));
    let writes = Arc::new(AtomicUsize::new(0));
    let mut o = Owner::with_store(Box::new(FaultDisk {
        disk: FileStore::in_private_directory(&d.leaf).unwrap(),
        mode,
        writes: writes.clone(),
    }));
    o.finish_restore().unwrap();
    o.stage(0, vec![window("primary")], Instant::now()).unwrap();
    assert!(o.flush().is_err());
    assert_eq!(o.failure(), Some(Failure::Unknown));
    assert_eq!(revision(&o), 0);
    assert!(o.dirty());
    assert_eq!(o.inspect_unknown().unwrap(), UnknownObservation::Candidate);
    assert!(o.retry_read().is_err());
    assert!(o.flush().is_err());
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    drop(o);
    let cold = d.open();
    assert_eq!(revision(&cold), 1);
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}
#[test]
fn unknown_prior_and_other_observations_do_not_unlock_or_replay_pending_candidate() {
    let d = Directory::new();
    let mut seed = ready(&d);
    seed.stage(0, vec![window("primary")], Instant::now())
        .unwrap();
    seed.flush().unwrap();
    drop(seed);
    let writes = Arc::new(AtomicUsize::new(0));
    let mut o = Owner::with_store(Box::new(FaultDisk {
        disk: FileStore::in_private_directory(&d.leaf).unwrap(),
        mode: Arc::new(AtomicUsize::new(3)),
        writes: writes.clone(),
    }));
    o.finish_restore().unwrap();
    o.stage(1, vec![window("pending")], Instant::now()).unwrap();
    assert!(o.flush().is_err());
    assert_eq!(o.inspect_unknown().unwrap(), UnknownObservation::Prior);
    assert_eq!(revision(&o), 1);
    let other = Snapshot {
        revision: 2,
        windows: vec![window("external")],
    }
    .value()
    .unwrap();
    fs::write(d.file(), serde_json::to_vec(&other).unwrap()).unwrap();
    assert_eq!(o.inspect_unknown().unwrap(), UnknownObservation::Other);
    assert!(o.flush().is_err());
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    drop(o);
    let cold = d.open();
    assert_eq!(
        cold.snapshot().unwrap().unwrap().windows[0].window_key,
        "external"
    );
}
#[test]
fn read_failure_after_success_is_not_empty_success_and_drop_never_flushes() {
    let d = Directory::new();
    let mut o = ready(&d);
    o.stage(0, vec![window("primary")], Instant::now()).unwrap();
    o.flush().unwrap();
    fs::write(d.file(), b"{partial").unwrap();
    assert!(o.retry_read().is_err());
    assert_eq!(revision(&o), 1);
    assert_eq!(o.failure(), Some(Failure::Read));
    drop(o);
    assert_eq!(fs::read(d.file()).unwrap(), b"{partial");
    fs::remove_file(d.file()).unwrap();
    let mut o = ready(&d);
    o.stage(0, vec![window("unsaved")], Instant::now()).unwrap();
    drop(o);
    assert!(!d.file().exists());
}
#[cfg(unix)]
#[test]
fn symlink_and_hardlink_records_are_rejected_without_touching_target() {
    use std::os::unix::fs::symlink;
    let d = Directory::new();
    let target = d.root.join("target");
    fs::write(&target, b"unchanged").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    }
    symlink(&target, d.file()).unwrap();
    let mut o = d.open();
    assert!(o.snapshot().is_err());
    assert!(o.flush().is_err());
    drop(o);
    assert_eq!(fs::read(&target).unwrap(), b"unchanged");
    fs::remove_file(d.file()).unwrap();
    fs::hard_link(&target, d.file()).unwrap();
    let o = d.open();
    assert!(o.snapshot().is_err());
    drop(o);
    fs::remove_file(&target).unwrap();
}
