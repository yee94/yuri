use super::*;
use serde_json::Map;
use std::{fs, path::PathBuf, sync::atomic::AtomicU64};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let base = std::env::temp_dir().canonicalize().unwrap();
        let path = base.join(format!(
            "file-journal-test-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn rows(text: &str) -> Value {
    let scope = json!({"host":{"hostID":"synthetic"},"authorityKey":"synthetic-authority","sessionID":"session","directory":"/workspace"});
    let key = format!(
        "{PREFIX}{}",
        json!([
            json!(["synthetic", "synthetic-authority", "session", "/workspace"]).to_string(),
            "/workspace/source.ts"
        ])
    );
    let record = json!({"version":1,"scope":scope,"path":"/workspace/source.ts","text":text,"base":"base","wire":"base","eol":"\n","bom":false,"pending":null,"conflict":false}).to_string();
    json!({key:record})
}
fn commit(v: u64, id: &str, rows: Value) -> Value {
    json!({"expectedVersion":v,"requestID":id,"records":rows})
}
fn sync(v: u64, id: &str) -> Value {
    json!({"version":v,"requestID":id})
}
#[derive(Default)]
struct Memory {
    value: Option<Snapshot>,
    write_mode: u8,
    sync_fail: bool,
    writes: usize,
    flushes: usize,
}
impl Disk for Memory {
    fn read(&mut self) -> Result<Snapshot> {
        Ok(self.value.clone().unwrap_or_else(Snapshot::empty))
    }
    fn write(&mut self, value: &Snapshot) -> Result<()> {
        self.writes += 1;
        if self.write_mode != 1 {
            self.value = Some(value.clone());
        }
        if self.write_mode != 0 {
            Err("synthetic_write_failed")
        } else {
            Ok(())
        }
    }
    fn sync(&mut self) -> Result<()> {
        self.flushes += 1;
        if self.sync_fail {
            Err("synthetic_sync_failed")
        } else {
            Ok(())
        }
    }
}
#[test]
fn schema_is_exact_and_credential_fields_never_enter_store() {
    assert!(records(&rows("草稿\n")).is_ok());
    let valid = rows("draft");
    let (key, raw) = valid.as_object().unwrap().iter().next().unwrap();
    for field in ["token", "lease", "request", "pathResolver"] {
        let mut v: Value = serde_json::from_str(raw.as_str().unwrap()).unwrap();
        v[field] = json!("forbidden");
        assert!(record(key, &v.to_string()).is_err());
    }
    let mut v: Value = serde_json::from_str(raw.as_str().unwrap()).unwrap();
    v["scope"]["host"]["lease"] = json!("forbidden");
    assert!(record(key, &v.to_string()).is_err());
    let mut store = Store::new(Memory::default()).unwrap();
    for field in ["data_dir", "path", "namespace", "authorization"] {
        let mut args = commit(0, "a", valid.clone());
        args[field] = json!("not-accepted");
        assert_eq!(
            store.call(METHODS[1], &args).unwrap_err(),
            "file_journal_schema"
        );
    }
    assert_eq!(store.disk.writes, 0);
}
#[test]
fn bounded_records_utf8_and_scope_identity() {
    let mut too_many = Map::new();
    for i in 0..21 {
        too_many.insert(i.to_string(), json!(""));
    }
    assert_eq!(
        records(&Value::Object(too_many)).unwrap_err(),
        "file_journal_capacity"
    );
    let mut too_large = Map::new();
    too_large.insert("x".into(), json!("界".repeat(BYTES / 3 + 1)));
    assert_eq!(
        records(&Value::Object(too_large)).unwrap_err(),
        "file_journal_capacity"
    );
    let valid = rows("draft");
    let (key, raw) = valid.as_object().unwrap().iter().next().unwrap();
    for path in [
        "/outside/source.ts",
        "/workspace/../source.ts",
        "/workspace",
    ] {
        let mut v: Value = serde_json::from_str(raw.as_str().unwrap()).unwrap();
        v["path"] = json!(path);
        assert!(record(key, &v.to_string()).is_err());
    }
}

#[test]
fn persisted_mutation_fences_are_exact_scope_only_and_never_contain_transport_credentials() {
    let key = format!(
        "desktop-file-operation-v1:{}",
        json!([
            "synthetic",
            "synthetic-authority",
            Value::Null,
            "/workspace"
        ])
    );
    let mut v = json!({"version":1,"scope":{"host":{"hostID":"synthetic"},"authorityKey":"synthetic-authority","sessionID":"session","directory":"/workspace"},"command":{"kind":"rename","path":"/workspace/source.ts","name":"target.ts"},"phase":"prepared"});
    assert!(records(&json!({key.clone():v.to_string()})).is_ok());
    v["scope"]["host"]["lease"] = json!("forbidden");
    assert!(records(&json!({key.clone():v.to_string()})).is_err());
    v["scope"]["host"].as_object_mut().unwrap().remove("lease");
    v["command"]["path"] = json!("/outside/source.ts");
    assert!(records(&json!({key:v.to_string()})).is_err());
}
#[test]
fn cas_and_real_barriers_precede_success() {
    let mut store = Store::new(Memory::default()).unwrap();
    let initial = store.disk.flushes;
    let v = store
        .call(METHODS[1], &commit(0, "a", rows("draft")))
        .unwrap();
    assert_eq!(v["version"], 1);
    assert!(store.disk.flushes > initial);
    assert_eq!(
        store
            .call(METHODS[1], &commit(0, "b", rows("other")))
            .unwrap_err(),
        "file_journal_owner_conflict"
    );
    assert_eq!(store.disk.writes, 1);
    assert_eq!(
        store.call(METHODS[2], &sync(1, "a")).unwrap()["status"],
        "ready"
    );
    assert_eq!(store.disk.writes, 1);
}
#[test]
fn unknown_after_data_publication_only_syncs_never_replays_or_rolls_back() {
    let mut store = Store::new(Memory {
        write_mode: 2,
        ..Memory::default()
    })
    .unwrap();
    assert_eq!(
        store
            .call(METHODS[1], &commit(0, "a", rows("draft")))
            .unwrap_err(),
        "file_journal_commit_unknown"
    );
    assert_eq!(
        store
            .call(METHODS[1], &commit(0, "b", rows("other")))
            .unwrap_err(),
        "file_journal_commit_unknown"
    );
    assert_eq!(store.call(METHODS[0], &json!({})).unwrap()["version"], 1);
    assert_eq!(store.call(METHODS[2], &sync(1, "a")).unwrap()["version"], 1);
    assert_eq!(store.disk.writes, 1);
}
#[test]
fn unknown_before_publication_can_only_be_denied_after_native_terminal_verification() {
    let mut store = Store::new(Memory {
        write_mode: 1,
        ..Memory::default()
    })
    .unwrap();
    assert!(
        store
            .call(METHODS[1], &commit(0, "a", rows("draft")))
            .is_err()
    );
    assert_eq!(
        store.call(METHODS[2], &sync(1, "a")).unwrap()["status"],
        "denied"
    );
    assert_eq!(store.current.version, 0);
    assert_eq!(store.disk.writes, 1);
}
#[test]
fn sync_failure_and_foreign_snapshot_remain_quarantined() {
    let mut store = Store::new(Memory::default()).unwrap();
    store.disk.sync_fail = true;
    assert!(
        store
            .call(METHODS[1], &commit(0, "a", rows("draft")))
            .is_err()
    );
    assert!(store.call(METHODS[2], &sync(1, "a")).is_err());
    store.disk.value = Some(Snapshot::empty());
    store.disk.value.as_mut().unwrap().version = 99;
    store.disk.sync_fail = false;
    assert!(store.call(METHODS[2], &sync(1, "a")).is_err());
    assert_eq!(store.disk.writes, 1);
}
#[test]
fn sha256_known_vectors() {
    let hex = |bytes: [u8; 32]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(
        hex(hash::sha256(b"")),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        hex(hash::sha256(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        hex(hash::sha256(&vec![b'a'; 1_000_000])),
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
}
#[test]
fn private_native_disk_cold_restart_keeps_receipt_and_delete_is_a_durable_snapshot() {
    let temp = Temp::new();
    let mut store = Store::new(disk::Files::open(&temp.0, "primary").unwrap()).unwrap();
    store
        .call(METHODS[1], &commit(0, "first", rows("持久草稿")))
        .unwrap();
    drop(store);
    let mut cold = Store::new(disk::Files::open(&temp.0, "primary").unwrap()).unwrap();
    let state = cold.call(METHODS[0], &json!({})).unwrap();
    assert_eq!(state["requestID"], "first");
    assert_eq!(state["records"], rows("持久草稿"));
    cold.call(METHODS[1], &commit(1, "discard", json!({})))
        .unwrap();
    drop(cold);
    let mut again = Store::new(disk::Files::open(&temp.0, "primary").unwrap()).unwrap();
    assert_eq!(
        again.call(METHODS[0], &json!({})).unwrap()["records"],
        json!({})
    );
    assert_eq!(
        fs::read_dir(temp.0.join("file-journal-v1/primary"))
            .unwrap()
            .count(),
        1
    );
}
#[test]
fn exclusive_native_owner_and_window_namespace_partition() {
    let temp = Temp::new();
    let first = disk::Files::open(&temp.0, "primary").unwrap();
    assert!(disk::Files::open(&temp.0, "primary").is_err());
    assert!(disk::Files::open(&temp.0, "secondary").is_ok());
    for name in ["", "../x", "a/b", "a\\b"] {
        assert!(disk::Files::open(&temp.0, name).is_err());
    }
    drop(first);
    assert!(disk::Files::open(&temp.0, "primary").is_ok());
}
#[test]
fn first_launch_creates_missing_native_app_data_descendants_without_following_links() {
    let temp = Temp::new();
    let root = temp.0.join("new-native-app/data");
    let mut files = disk::Files::open(&root, "primary").unwrap();
    assert_eq!(files.read().unwrap(), Snapshot::empty());
    drop(files);
    assert!(root.join("file-journal-v1/primary/snapshots.bin").is_file());
    #[cfg(target_os = "macos")]
    {
        let other = Temp::new();
        std::os::unix::fs::symlink(&other.0, temp.0.join("linked-data")).unwrap();
        assert!(disk::Files::open(&temp.0.join("linked-data/new-child"), "primary").is_err());
        assert_eq!(fs::read_dir(&other.0).unwrap().count(), 0);
    }
}

#[test]
fn child_owner_probe() {
    let Some(root) = std::env::var_os("FILE_JOURNAL_LOCK_TEST_DIR") else {
        return;
    };
    let result = disk::Files::open(Path::new(&root), "primary");
    assert_eq!(
        result.is_err(),
        std::env::var("FILE_JOURNAL_LOCK_EXPECT").unwrap() == "locked"
    );
}
#[test]
fn separate_process_cannot_override_live_native_owner() {
    let temp = Temp::new();
    let owner = disk::Files::open(&temp.0, "primary").unwrap();
    let probe = |expect: &str| {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "file_journal::tests::child_owner_probe"])
            .env("FILE_JOURNAL_LOCK_TEST_DIR", &temp.0)
            .env("FILE_JOURNAL_LOCK_EXPECT", expect)
            .status()
            .unwrap();
        assert!(status.success());
    };
    probe("locked");
    drop(owner);
    probe("free");
}
#[test]
fn incomplete_inactive_slot_preserves_committed_snapshot_but_torn_commit_magic_fails_closed() {
    use std::io::{Seek, SeekFrom, Write};
    let temp = Temp::new();
    drop(disk::Files::open(&temp.0, "primary").unwrap());
    let path = temp.0.join("file-journal-v1/primary/snapshots.bin");
    let mut f = fs::OpenOptions::new().write(true).open(&path).unwrap();
    f.seek(SeekFrom::Start((WIRE + 64) as u64)).unwrap();
    f.write_all(b"YFSTG001").unwrap();
    f.sync_all().unwrap();
    f.seek(SeekFrom::Current(56)).unwrap();
    f.write_all(b"incomplete staged payload").unwrap();
    f.sync_all().unwrap();
    drop(f);
    let mut store = Store::new(disk::Files::open(&temp.0, "primary").unwrap()).unwrap();
    assert_eq!(store.current.version, 0);
    assert!(
        store
            .call(METHODS[1], &commit(0, "a", rows("new draft")))
            .is_ok()
    );
    drop(store);
    let mut f = fs::OpenOptions::new().write(true).open(&path).unwrap();
    f.seek(SeekFrom::Start((WIRE + 64) as u64)).unwrap();
    f.write_all(b"YFJ").unwrap();
    f.sync_all().unwrap();
    drop(f);
    // The inactive slot in the first half was known staging, not a failed committed
    // snapshot. In contrast, corrupt committed magic is never interpreted as empty.
    // Here overwriting with the same first three bytes is still a valid commit.
    let mut f = fs::OpenOptions::new().write(true).open(path).unwrap();
    f.seek(SeekFrom::Start((WIRE + 64 + 3) as u64)).unwrap();
    f.write_all(b"!").unwrap();
    f.sync_all().unwrap();
    drop(f);
    assert!(Store::new(disk::Files::open(&temp.0, "primary").unwrap()).is_err());
}
#[cfg(target_os = "macos")]
#[test]
fn private_paths_reject_symlink_hardlink_and_public_permissions_without_touching_target() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let temp = Temp::new();
    let other = Temp::new();
    symlink(&other.0, temp.0.join("file-journal-v1")).unwrap();
    assert!(disk::Files::open(&temp.0, "primary").is_err());
    assert_eq!(fs::read_dir(&other.0).unwrap().count(), 0);
    fs::remove_file(temp.0.join("file-journal-v1")).unwrap();
    drop(disk::Files::open(&temp.0, "primary").unwrap());
    let path = temp.0.join("file-journal-v1/primary/snapshots.bin");
    let original = fs::read(&path).unwrap();
    fs::hard_link(&path, temp.0.join("hardlink")).unwrap();
    assert!(disk::Files::open(&temp.0, "primary").is_err());
    fs::remove_file(temp.0.join("hardlink")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(disk::Files::open(&temp.0, "primary").is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
}
#[test]
fn corrupt_committed_data_never_falls_back_to_a_clean_previous_slot() {
    use std::io::{Seek, SeekFrom, Write};
    let temp = Temp::new();
    let mut files = disk::Files::open(&temp.0, "primary").unwrap();
    let next = Snapshot {
        version: 1,
        request: Some("a".into()),
        records: records(&rows("draft")).unwrap(),
    };
    files.write(&next).unwrap();
    drop(files);
    let path = temp.0.join("file-journal-v1/primary/snapshots.bin");
    let mut f = fs::OpenOptions::new().write(true).open(path).unwrap();
    f.seek(SeekFrom::Start((WIRE + 64 + 64) as u64)).unwrap();
    f.write_all(b"X").unwrap();
    f.sync_all().unwrap();
    drop(f);
    assert!(Store::new(disk::Files::open(&temp.0, "primary").unwrap()).is_err());
}

#[test]
#[ignore = "set NSH_FILE_JOURNAL_FIXTURE to the bun-built isolated TS fixture; no window"]
fn real_quickjs_adapter_and_native_disk_admit_save_discard_then_cold_unknown_is_get_only() {
    use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
    use std::sync::Mutex;
    struct Sink;
    impl MountSink for Sink {
        fn submit(&self, _: nsh_core::MountBatch) {}
    }
    let source = fs::read_to_string(
        std::env::var("NSH_FILE_JOURNAL_FIXTURE").expect("build isolated TS fixture"),
    )
    .unwrap();
    let temp = Temp::new();
    let wire = Arc::new(Mutex::new("base".to_string()));
    for phase in 1..=2 {
        let host = HostChannel::default();
        let owner = install(&host, &temp.0, "primary").unwrap();
        let (tx, rx) = mpsc::channel();
        host.handle("test.phase", move |call| {
            call.resolve(json!(phase));
        });
        host.handle("test.result", move |mut call| {
            tx.send(call.take_data()).unwrap();
        });
        let writes = Arc::new(AtomicU64::new(0));
        let count = writes.clone();
        let data = wire.clone();
        host.handle("test.document", move |mut call| {
            let input = call.take_data();
            let path = input["path"].as_str().unwrap(); let mut wire = data.lock().unwrap();
            let value = if input["method"] == "POST" {
                count.fetch_add(1, Ordering::Relaxed); *wire = input["body"]["content"].as_str().unwrap().into();
                if *wire == "UNKNOWN_NATIVE" { json!({"error":"synthetic_lost_post_receipt"}) } else { json!({"success":true,"path":"/workspace/source.ts"}) }
            } else if path.starts_with("/api/fs/stat?") { json!({"path":"/workspace/source.ts","isFile":true,"isBinary":false,"mimeType":"text/plain","size":wire.len(),"mtimeMs":1}) }
            else if path.starts_with("/api/fs/read?") { json!(*wire) } else { panic!("unexpected synthetic route") };
            call.resolve(value);
        });
        let mut bundle = Bundle::source(source.clone());
        bundle.policy.declared =
            Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
        let mut config = EngineConfig::new(bundle);
        config.host = host;
        let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
        let output = rx.recv_timeout(Duration::from_secs(30)).unwrap();
        assert!(output.get("error").is_none(), "{output}");
        if phase == 1 {
            assert_eq!(output["saved"], true);
            assert_eq!(output["discarded"], true);
            assert_eq!(output["clean"], "SAVED_NATIVE");
            assert_eq!(output["uncertain"], false);
            assert_eq!(output["pending"], true);
            assert_eq!(writes.load(Ordering::Relaxed), 2);
        } else {
            assert_eq!(output["restored"]["text"], "LATER_NATIVE_INPUT");
            assert_eq!(output["restored"]["pending"], true);
            assert_eq!(output["text"], "LATER_NATIVE_INPUT");
            assert_eq!(output["pending"], false);
            assert_eq!(output["operationRestored"], true);
            assert_eq!(output["operationProtected"], true);
            assert_eq!(writes.load(Ordering::Relaxed), 0);
        }
        drop(engine);
        drop(owner);
        // Native worker owns the pinned file, not Engine or the caller. Wait for
        // shutdown before creating another process-equivalent store instance.
        std::thread::sleep(Duration::from_millis(100));
    }
}
