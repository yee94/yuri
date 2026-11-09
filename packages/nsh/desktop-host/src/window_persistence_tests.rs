//! Real owner-only temporary FileStore, synthetic faults; never native home discovery.
use super::*;
use crate::{
    notifications::store::{FileStore, Store},
    window_geometry::{Geometry, Rect, Space},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

pub(crate) fn record(key: &str) -> MainWindow {
    MainWindow {
        window_key: key.into(),
        connection_id: "fixture-host".into(),
        runtime_key: "nsh:fixture-host".into(),
        geometry: Geometry {
            space: Space::AppKitPoints,
            normal: Rect {
                x: 80.,
                y: 100.,
                width: 1200.,
                height: 800.,
            },
            maximized: false,
            fullscreen: false,
        },
    }
}
pub(crate) fn wait(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < deadline, "synthetic persistence deadline");
        std::thread::sleep(Duration::from_millis(1));
    }
}
struct Observed {
    disk: FileStore,
    mode: Arc<AtomicUsize>,
    writes: Arc<AtomicUsize>,
    entered: Arc<AtomicBool>,
    release: Arc<AtomicBool>,
}
impl Store for Observed {
    fn load(&mut self) -> Result<Option<serde_json::Value>> {
        self.disk.load()
    }
    fn commit(&mut self, next: &serde_json::Value) -> Result<()> {
        assert_eq!(std::thread::current().name(), Some("yuri-window-state"));
        self.writes.fetch_add(1, Ordering::AcqRel);
        match self.mode.load(Ordering::Acquire) {
            1 => Err("fixture_write_denied".into()),
            2 => {
                self.disk.commit(next)?;
                Err("notification_store_unknown".into())
            }
            3 => {
                self.entered.store(true, Ordering::Release);
                wait(|| self.release.load(Ordering::Acquire));
                self.disk.commit(next)
            }
            _ => self.disk.commit(next),
        }
    }
}
pub(crate) struct DiskFixture {
    pub path: PathBuf,
    pub mode: Arc<AtomicUsize>,
    pub writes: Arc<AtomicUsize>,
    pub entered: Arc<AtomicBool>,
    pub release: Arc<AtomicBool>,
    port: Option<Port>,
}
impl DiskFixture {
    pub fn new(saved: Option<Vec<MainWindow>>) -> Self {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("nsh-persistence-{}", crate::vault::id().unwrap()));
        let path = root.join("window-state");
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        }
        #[cfg(windows)]
        {
            fs::create_dir(&root).unwrap();
            fs::create_dir(&path).unwrap();
        }
        if let Some(windows) = saved {
            FileStore::in_private_directory(&path)
                .unwrap()
                .commit(
                    &Snapshot {
                        revision: 1,
                        windows,
                    }
                    .value()
                    .unwrap(),
                )
                .unwrap();
        }
        let mut fixture = Self {
            path,
            mode: Arc::default(),
            writes: Arc::default(),
            entered: Arc::default(),
            release: Arc::default(),
            port: None,
        };
        let directory = fixture.path.clone();
        let mode = fixture.mode.clone();
        let writes = fixture.writes.clone();
        let entered = fixture.entered.clone();
        let release = fixture.release.clone();
        fixture.port = Some(
            Port::install(move || {
                let disk = FileStore::in_private_directory(&directory)?;
                window_state::Owner::from_granted_store(
                    &directory,
                    Box::new(Observed {
                        disk,
                        mode,
                        writes,
                        entered,
                        release,
                    }),
                )
            })
            .unwrap(),
        );
        fixture
    }
    pub fn port(&self) -> Port {
        self.port.as_ref().unwrap().clone()
    }
    pub fn file(&self) -> PathBuf {
        self.path.join("desktop-notification-receipts.json")
    }
}
impl Drop for DiskFixture {
    fn drop(&mut self) {
        self.release.store(true, Ordering::Release);
        self.port.take();
        wait(|| FileStore::in_private_directory(&self.path).is_ok());
        for entry in fs::read_dir(&self.path).unwrap() {
            let path = entry.unwrap().path();
            assert!(
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("desktop-notification-receipts")
            );
            fs::remove_file(path).unwrap();
        }
        fs::remove_dir(&self.path).unwrap();
        fs::remove_dir(self.path.parent().unwrap()).unwrap();
    }
}
fn flush(port: &Port, windows: Vec<MainWindow>, quit: bool) -> Result<()> {
    port.flush(windows, quit)?
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
}

#[test]
fn worker_restores_complete_catalog_rejects_partial_and_timeout_never_clears_failure() {
    let a = record("primary");
    let b = record("secondary");
    let disk = DiskFixture::new(Some(vec![a.clone(), b.clone()]));
    let port = disk.port();
    assert_eq!(
        flush(&port, vec![a.clone()], false).unwrap_err(),
        "window_state_restore_incomplete"
    );
    assert_eq!(disk.writes.load(Ordering::Acquire), 0);
    // A timeout/no-op must not turn the partial capture into apparent successful restoration.
    std::thread::sleep(Duration::from_millis(1100));
    assert_eq!(
        port.status().unwrap().error.as_deref(),
        Some("window_state_restore_incomplete")
    );
    assert_eq!(
        port.status().unwrap().snapshot.unwrap().windows,
        vec![a.clone(), b.clone()]
    );
    flush(&port, vec![a, b], false).unwrap();
    assert!(port.status().unwrap().error.is_none());
    assert_eq!(disk.writes.load(Ordering::Acquire), 0);
    assert!(FileStore::in_private_directory(&disk.path).is_err());
}

#[test]
fn worker_known_write_failure_preserves_prior_and_only_explicit_flush_retries_unknown_never_replays()
 {
    let a = record("primary");
    let mut moved = a.clone();
    moved.geometry.normal.x += 30.;
    let disk = DiskFixture::new(Some(vec![a.clone()]));
    let port = disk.port();
    disk.mode.store(1, Ordering::Release);
    assert!(flush(&port, vec![moved.clone()], false).is_err());
    assert_eq!(port.status().unwrap().snapshot.unwrap().windows, vec![a]);
    let prior = fs::read(disk.file()).unwrap();
    for _ in 0..50 {
        port.capture(vec![moved.clone()]).unwrap();
    }
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(disk.writes.load(Ordering::Acquire), 1);
    assert_eq!(fs::read(disk.file()).unwrap(), prior);
    disk.mode.store(0, Ordering::Release);
    flush(&port, vec![moved.clone()], false).unwrap();
    assert!(port.status().unwrap().error.is_none());
    disk.mode.store(2, Ordering::Release);
    moved.geometry.normal.x += 30.;
    assert!(flush(&port, vec![moved.clone()], true).is_err());
    let writes = disk.writes.load(Ordering::Acquire);
    assert_eq!(
        flush(&port, vec![moved], true).unwrap_err(),
        "window_state_unknown"
    );
    assert_eq!(disk.writes.load(Ordering::Acquire), writes);
}

#[test]
fn worker_coalesces_only_trailing_capture_keeps_fifo_barriers_and_cancel_and_drop_never_flushes() {
    let a = record("primary");
    let disk = DiskFixture::new(None);
    let port = disk.port();
    disk.mode.store(3, Ordering::Release);
    let first = port.flush(vec![a.clone()], true).unwrap();
    wait(|| disk.entered.load(Ordering::Acquire));
    port.cancel_quit().unwrap();
    let mut moved = a.clone();
    moved.geometry.normal.x = 500.;
    for _ in 0..10_000 {
        port.capture(vec![moved.clone()]).unwrap();
    }
    assert_eq!(
        port.inbox.lock().unwrap().len(),
        2,
        "one cancel + one undispatched complete capture"
    );
    let second = port.flush(vec![moved.clone()], false).unwrap();
    let mut newest = moved;
    newest.geometry.normal.x = 700.;
    port.capture(vec![newest.clone()]).unwrap();
    disk.release.store(true, Ordering::Release);
    first.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    second
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    wait(|| {
        port.status()
            .unwrap()
            .snapshot
            .as_ref()
            .is_some_and(|s| s.windows == vec![newest.clone()])
    });
    assert_eq!(
        disk.writes.load(Ordering::Acquire),
        3,
        "two explicit barriers and one debounced newest capture"
    );
    port.closed(Vec::new()).unwrap();
    assert_eq!(
        disk.writes.load(Ordering::Acquire),
        3,
        "last close never writes empty"
    );
}

#[test]
fn last_port_drop_does_not_flush_pending_capture_or_touch_prior_durable_file() {
    let a = record("primary");
    let mut disk = DiskFixture::new(Some(vec![a.clone()]));
    let prior = fs::read(disk.file()).unwrap();
    let mut changed = a;
    changed.geometry.normal.x += 50.;
    disk.port.as_ref().unwrap().capture(vec![changed]).unwrap();
    disk.port.take();
    wait(|| FileStore::in_private_directory(&disk.path).is_ok());
    assert_eq!(disk.writes.load(Ordering::Acquire), 0);
    assert_eq!(fs::read(disk.file()).unwrap(), prior);
}
