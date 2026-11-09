use super::*;
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = PathBuf::from(
            std::env::var_os("NSH_SSH_IO_FIXTURE_ROOT")
                .expect("synthetic IO fixture root must be explicitly supplied"),
        );
        let path = root.join(format!(
            "home-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn put(&self, name: &str, content: &[u8]) {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fn local(&self) -> Local {
        Local::new(self.0.clone(), "synthetic".into()).unwrap()
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct FixtureSsh {
    home: PathBuf,
    applies: AtomicUsize,
    drop_ack: AtomicBool,
}
impl FixtureSsh {
    fn new(home: &Home) -> Arc<Self> {
        Arc::new(Self {
            home: home.0.clone(),
            applies: AtomicUsize::new(0),
            drop_ack: AtomicBool::new(false),
        })
    }
}
impl ProgramTransport for FixtureSsh {
    fn exchange(&self, _: &Instance, request: &Value, cancel: &Cancellation) -> Result<Value> {
        cancel.check()?;
        if request["op"] == "apply" {
            self.applies.fetch_add(1, Ordering::SeqCst);
        }
        let node =
            std::env::var_os("NSH_SSH_IO_NODE").expect("explicit fixture Node executable required");
        let mut child = Command::new(node)
            .arg("-")
            .env_clear()
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| Error::Unavailable)?;
        let source = format!("const request={request};\n{}", file_program());
        child
            .stdin
            .take()
            .ok_or(Error::Unavailable)?
            .write_all(source.as_bytes())
            .map_err(|_| Error::Ssh)?;
        let output = child.wait_with_output().map_err(|_| Error::Ssh)?;
        if !output.status.success() {
            return Err(Error::Ssh);
        }
        if request["op"] == "apply" && self.drop_ack.swap(false, Ordering::AcqRel) {
            return Err(Error::Ssh);
        }
        serde_json::from_slice(&output.stdout).map_err(|_| Error::Invalid)
    }
}
fn remote(home: &Home) -> (Remote, Arc<FixtureSsh>) {
    let driver = FixtureSsh::new(home);
    let target=Instance::parse(&json!({"id":"synthetic","label":"Synthetic IO","host":"ssh.example.invalid","user":"fixture","port":22,"remotePort":3210,"localPort":0,"managed":true})).unwrap();
    (
        Remote::new(target, "synthetic".into(), driver.clone()).unwrap(),
        driver,
    )
}
fn alter(before: &[Entry], name: &str, content: &[u8]) -> Vec<Entry> {
    let mut after = before.to_vec();
    if let Some(e) = after.iter_mut().find(|e| e.name == name) {
        e.content = content.into();
    } else {
        after.push(Entry {
            name: name.into(),
            content: content.into(),
            version: "synthetic-new".into(),
            mode: 0o600,
        });
    }
    after
}
fn data(home: &Home, name: &str) -> Vec<u8> {
    fs::read(home.0.join(name)).unwrap()
}
fn count(path: &Path) -> usize {
    fs::read_dir(path).unwrap().count()
}

#[test]
fn actual_local_and_fixed_ssh_program_sync_full_allowlist_binary_npm_jsonc_and_preserve_exclusions()
{
    let source = Home::new();
    let target = Home::new();
    source.put(".config/opencode/opencode.jsonc",b"\xef\xbb\xbf{/*preserve*/\"plugin\":[[\"portable@^2\",{\"keep\":true}],\"./private\"],\"plugins\":[{\"package\":\"@scope/npm\",\"options\":{\"x\":1}},{\"package\":\"file:///private\"}]}");
    for name in [
        "AGENTS.md",
        "cursor-models.json",
        "agents/main.md",
        "commands/do.md",
        "skills/test/SKILL.md",
        "snippet/a.txt",
        "snippets/b.txt",
        "plugins/helper.cjs",
    ] {
        source.put(&format!(".config/opencode/{name}"), b"synthetic body");
    }
    source.put(
        ".config/opencode/skills/test/literal-$(not-a-command).bin",
        &[0, 255, 13, 10, 1],
    );
    source.put(".agents/skills/root/SKILL.md", b"root skill");
    source.put(
        ".config/opencode/plugins/node_modules/private.bin",
        b"do not transfer",
    );
    target.put(".config/opencode/config.json", b"{}");
    target.put(".config/opencode/agent/stale.md", b"legacy");
    target.put(
        ".config/opencode/plugins/node_modules/keep.bin",
        b"preserve excluded",
    );
    target.put(".config/opencode/private-store/keep", b"not allowlisted");
    let (remote, driver) = remote(&target);
    let files = Arc::new(NativeFiles::new(
        source.local(),
        remote,
        Cancellation::default(),
    ));
    let owner = sync::SyncOwner::new(files);
    let preview = owner.preview("full-push", sync::Direction::Push).unwrap();
    assert_eq!(preview["directories"].as_array().unwrap().len(), 6);
    assert!(!preview.to_string().contains("synthetic body"));
    owner.apply("full-push", &Cancellation::default()).unwrap();
    let content = data(&target, ".config/opencode/opencode.jsonc");
    let text = std::str::from_utf8(&content).unwrap();
    assert!(content.starts_with(&[0xef, 0xbb, 0xbf]));
    assert!(text.contains("/*preserve*/"));
    assert!(text.contains("\"keep\":true"));
    assert!(text.contains("@scope/npm"));
    assert!(!text.contains("./private"));
    assert!(!text.contains("file:///private"));
    assert_eq!(
        data(
            &target,
            ".config/opencode/skills/test/literal-$(not-a-command).bin"
        ),
        vec![0, 255, 13, 10, 1]
    );
    assert_eq!(data(&target, ".agents/skills/root/SKILL.md"), b"root skill");
    assert!(!target.0.join(".config/opencode/agent/stale.md").exists());
    assert_eq!(
        data(&target, ".config/opencode/plugins/node_modules/keep.bin"),
        b"preserve excluded"
    );
    assert_eq!(
        data(&target, ".config/opencode/private-store/keep"),
        b"not allowlisted"
    );
    assert_eq!(driver.applies.load(Ordering::SeqCst), 1);
}
#[test]
fn actual_local_target_cas_failure_is_durable_and_never_overwrites_later_edit() {
    let home = Home::new();
    home.put(".config/opencode/opencode.json", b"{}");
    let endpoint = home.local();
    let before = endpoint.read(&Cancellation::default()).unwrap();
    let after = alter(&before, "opencode.json", b"{\"next\":true}");
    home.put(".config/opencode/opencode.json", b"later user edit");
    assert_eq!(
        endpoint.replace("cas-run", &before, &after, &Cancellation::default()),
        Err(Error::Stale)
    );
    assert_eq!(endpoint.receipt("cas-run").unwrap(), Some(false));
    assert_eq!(
        data(&home, ".config/opencode/opencode.json"),
        b"later user edit"
    );
    assert_eq!(
        endpoint.replace("cas-run", &before, &after, &Cancellation::default()),
        Err(Error::Stale)
    );
}

#[test]
fn actual_pull_respects_selected_scope_and_missing_source_never_deletes_destination() {
    let local = Home::new();
    let source = Home::new();
    local.put(".config/opencode/opencode.json", b"{\"keep\":true}");
    local.put(".config/opencode/AGENTS.md", b"old");
    local.put(".config/opencode/skills/keep/SKILL.md", b"keep");
    source.put(".config/opencode/AGENTS.md", b"selected remote");
    source.put(".config/opencode/cursor-models.json", b"not selected");
    let (remote, driver) = remote(&source);
    let owner = sync::SyncOwner::new(Arc::new(NativeFiles::new(
        local.local(),
        remote,
        Cancellation::default(),
    )));
    let selected=sync::Selections::parse(&json!({"fileGroups":[true],"singleFiles":[true,false],"directories":[true,true,true,true,true,true],"agentsRoot":true,"providerCredentials":false,"magpie":false})).unwrap();
    let preview = owner
        .preview_selected("selected-pull", sync::Direction::Pull, selected)
        .unwrap();
    assert_eq!(preview["files"].as_array().unwrap().len(), 1);
    assert!(preview["deletes"].as_array().unwrap().is_empty());
    owner
        .apply("selected-pull", &Cancellation::default())
        .unwrap();
    assert_eq!(
        data(&local, ".config/opencode/AGENTS.md"),
        b"selected remote"
    );
    assert_eq!(
        data(&local, ".config/opencode/opencode.json"),
        b"{\"keep\":true}"
    );
    assert_eq!(
        data(&local, ".config/opencode/skills/keep/SKILL.md"),
        b"keep"
    );
    assert!(!local.0.join(".config/opencode/cursor-models.json").exists());
    assert_eq!(driver.applies.load(Ordering::SeqCst), 0);
    assert_eq!(
        owner.history(sync::Direction::Pull).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(sync::Selections::parse(&json!({"fileGroups":[true],"singleFiles":[true,false],"directories":[true],"agentsRoot":true,"providerCredentials":false,"magpie":false})).is_err());
}
#[test]
fn actual_local_lost_ack_reads_durable_receipt_without_replacing_again() {
    let home = Home::new();
    home.put(".config/opencode/opencode.json", b"{}");
    let endpoint = home.local().observe(Arc::new(|point| {
        if point == local::Point::ReceiptSynced {
            Err(Error::Unavailable)
        } else {
            Ok(())
        }
    }));
    let before = endpoint.read(&Cancellation::default()).unwrap();
    let after = alter(&before, "opencode.json", b"{\"committed\":true}");
    assert_eq!(
        endpoint.replace("lost-ack", &before, &after, &Cancellation::default()),
        Err(Error::SyncUnknown)
    );
    let modified = fs::metadata(home.0.join(".config/opencode/opencode.json"))
        .unwrap()
        .modified()
        .unwrap();
    let reloaded = home.local();
    assert_eq!(reloaded.receipt("lost-ack").unwrap(), Some(true));
    assert_eq!(reloaded.history().unwrap().len(), 1);
    assert_eq!(
        fs::metadata(home.0.join(".config/opencode/opencode.json"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
}
#[test]
fn actual_local_cancel_after_replace_is_unknown_with_backup_and_zero_replay() {
    let home = Home::new();
    home.put(".config/opencode/opencode.json", b"{}");
    let cancel = Cancellation::default();
    let captured = cancel.clone();
    let endpoint = home.local().observe(Arc::new(move |point| {
        if point == local::Point::Replaced(1) {
            captured.cancel();
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }));
    let before = endpoint.read(&Cancellation::default()).unwrap();
    let after = alter(&before, "opencode.json", b"{\"written\":true}");
    assert_eq!(
        endpoint.replace("cancel-run", &before, &after, &cancel),
        Err(Error::SyncUnknown)
    );
    assert_eq!(endpoint.receipt("cancel-run").unwrap(), None);
    assert_eq!(
        data(
            &home,
            ".config/opencode/.yuri.sync-backup/9-synthetic-cancel-run/opencode.json"
        ),
        b"{}"
    );
    assert_eq!(
        endpoint.replace("cancel-run", &before, &after, &Cancellation::default()),
        Err(Error::SyncUnknown)
    );
    assert_eq!(
        endpoint.replace("new-run", &before, &after, &Cancellation::default()),
        Err(Error::SyncUnknown)
    );
}
#[test]
fn actual_local_backup_keeps_five_generations_but_all_run_receipts() {
    let home = Home::new();
    home.put(".config/opencode/opencode.json", b"0");
    let endpoint = home.local();
    for n in 1..=7 {
        let before = endpoint.read(&Cancellation::default()).unwrap();
        let after = alter(&before, "opencode.json", n.to_string().as_bytes());
        endpoint
            .replace(
                &format!("backup-{n}"),
                &before,
                &after,
                &Cancellation::default(),
            )
            .unwrap();
    }
    assert_eq!(count(&home.0.join(".config/opencode/.yuri.sync-backup")), 5);
    assert_eq!(count(&home.0.join(".yuri.sync-backup-agents")), 5);
    assert_eq!(endpoint.history().unwrap().len(), 7);
    assert_eq!(endpoint.receipt("backup-1").unwrap(), Some(true));
    assert_eq!(
        data(
            &home,
            ".config/opencode/.yuri.sync-backup/9-synthetic-backup-3/opencode.json"
        ),
        b"2"
    );
}
#[test]
fn actual_fixed_ssh_lost_ack_is_read_only_and_cas_never_replays() {
    let home = Home::new();
    home.put(".config/opencode/opencode.json", b"{}");
    let (endpoint, driver) = remote(&home);
    let before = endpoint.read(&Cancellation::default()).unwrap();
    let after = alter(&before, "opencode.json", b"{\"native\":true}");
    driver.drop_ack.store(true, Ordering::SeqCst);
    assert_eq!(
        endpoint.replace("remote-lost", &before, &after, &Cancellation::default()),
        Err(Error::SyncUnknown)
    );
    assert_eq!(endpoint.receipt("remote-lost").unwrap(), Some(true));
    assert_eq!(driver.applies.load(Ordering::SeqCst), 1);
    assert_eq!(endpoint.history().unwrap().len(), 1);
    let before = endpoint.read(&Cancellation::default()).unwrap();
    let after = alter(&before, "opencode.json", b"next");
    home.put(".config/opencode/opencode.json", b"newer edit");
    assert_eq!(
        endpoint.replace("remote-cas", &before, &after, &Cancellation::default()),
        Err(Error::Stale)
    );
    assert_eq!(endpoint.receipt("remote-cas").unwrap(), Some(false));
    assert_eq!(data(&home, ".config/opencode/opencode.json"), b"newer edit");
}
#[test]
fn actual_files_malformed_config_and_symlinks_fail_before_mutation() {
    let source = Home::new();
    let target = Home::new();
    source.put(".config/opencode/opencode.jsonc", b"{broken}");
    let (remote, driver) = remote(&target);
    let files = Arc::new(NativeFiles::new(
        source.local(),
        remote,
        Cancellation::default(),
    ));
    let owner = sync::SyncOwner::new(files);
    assert_eq!(
        owner
            .preview("malformed", sync::Direction::Push)
            .unwrap_err(),
        Error::Invalid
    );
    assert_eq!(driver.applies.load(Ordering::SeqCst), 0);
    assert!(!target.0.join(".config/opencode/.yuri.sync-runs").exists());
    #[cfg(unix)]
    {
        let home = Home::new();
        let outside = Home::new();
        outside.put("private", b"synthetic private");
        fs::create_dir_all(home.0.join(".config/opencode")).unwrap();
        std::os::unix::fs::symlink(
            outside.0.join("private"),
            home.0.join(".config/opencode/opencode.json"),
        )
        .unwrap();
        assert!(matches!(
            home.local().read(&Cancellation::default()),
            Err(Error::Invalid)
        ));
        let (endpoint, _) = super::tests::remote(&home);
        assert!(matches!(
            endpoint.read(&Cancellation::default()),
            Err(Error::Invalid)
        ));
    }
}

#[test]
fn target_lock_is_shared_across_identities_and_local_fixed_ssh_endpoints() {
    let home = Home::new();
    home.put(".config/opencode/opencode.json", b"{}");
    let second = Arc::new(Local::new(home.0.clone(), "other".into()).unwrap());
    let (remote, _) = remote(&home);
    let remote = Arc::new(remote);
    let before = second.read(&Cancellation::default()).unwrap();
    let after = alter(&before, "opencode.json", b"updated");
    let b = before.clone();
    let a = after.clone();
    let endpoint = home.local().observe(Arc::new(move |point| {
        if point == local::Point::Prepared {
            assert_eq!(
                second.replace("second", &b, &a, &Cancellation::default()),
                Err(Error::Busy)
            );
            assert_eq!(
                remote.replace("remote", &b, &a, &Cancellation::default()),
                Err(Error::Busy)
            );
        }
        Ok(())
    }));
    endpoint
        .replace("first", &before, &after, &Cancellation::default())
        .unwrap();
    assert_eq!(data(&home, ".config/opencode/opencode.json"), b"updated");
}

#[test]
fn native_files_propagates_per_operation_cancel_during_actual_io_and_other_identity_cannot_bypass_unknown()
 {
    let home = Home::new();
    home.put(".config/opencode/opencode.json", b"{}");
    home.put(".config/opencode/AGENTS.md", b"prior");
    let cancel = Cancellation::default();
    let c = cancel.clone();
    let local = home.local().observe(Arc::new(move |point| {
        if point == local::Point::Replaced(1) {
            c.cancel();
        }
        Ok(())
    }));
    let before = local.read(&Cancellation::default()).unwrap();
    let after = alter(
        &alter(&before, "AGENTS.md", b"next"),
        "opencode.json",
        b"next",
    );
    let (remote, _) = remote(&home);
    let files = NativeFiles::new(local, remote, Cancellation::default());
    assert_eq!(
        sync::Files::replace(&files, false, "linked-cancel", &before, &after, &cancel),
        Err(Error::SyncUnknown)
    );
    let other = Local::new(home.0.clone(), "another-identity".into()).unwrap();
    let now = other.read(&Cancellation::default()).unwrap();
    assert_eq!(
        other.replace("bypass", &now, &now, &Cancellation::default()),
        Err(Error::SyncUnknown)
    );
    let (remote, _) = self::remote(&home);
    assert_eq!(
        remote.replace("bypass", &now, &now, &Cancellation::default()),
        Err(Error::SyncUnknown)
    );
}

#[test]
fn malformed_durable_receipt_never_upgrades_from_matching_target_bytes() {
    for use_remote in [false, true] {
        let home = Home::new();
        home.put(".config/opencode/opencode.json", b"{}");
        let (endpoint, _) = remote(&home);
        let local = home.local();
        let endpoint: &dyn Endpoint = if use_remote { &endpoint } else { &local };
        let before = endpoint.read(&Cancellation::default()).unwrap();
        let after = alter(&before, "opencode.json", b"committed");
        endpoint
            .replace("corrupt", &before, &after, &Cancellation::default())
            .unwrap();
        home.put(
            ".config/opencode/.yuri.sync-runs/synthetic/corrupt/receipt.json",
            b"{\"record\":\"{}\",\"sha256\":\"bad\"}",
        );
        assert!(endpoint.receipt("corrupt").is_err());
        assert!(endpoint.history().is_err());
        let now = endpoint.read(&Cancellation::default()).unwrap();
        assert!(
            endpoint
                .replace("new-after-corrupt", &now, &now, &Cancellation::default())
                .is_err()
        );
        assert_eq!(data(&home, ".config/opencode/opencode.json"), b"committed");
    }
}

#[test]
fn fixed_ssh_five_backups_and_abandoned_target_lock_do_not_get_automatically_replayed() {
    let home = Home::new();
    home.put(".config/opencode/opencode.json", b"0");
    let (endpoint, driver) = remote(&home);
    for n in 1..=7 {
        let before = endpoint.read(&Cancellation::default()).unwrap();
        let after = alter(&before, "opencode.json", n.to_string().as_bytes());
        endpoint
            .replace(
                &format!("remote-backup-{n}"),
                &before,
                &after,
                &Cancellation::default(),
            )
            .unwrap();
    }
    assert_eq!(count(&home.0.join(".config/opencode/.yuri.sync-backup")), 5);
    assert_eq!(endpoint.history().unwrap().len(), 7);
    let lock = home.0.join(".config/opencode/.yuri.sync-target-lock");
    fs::create_dir(&lock).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let before = endpoint.read(&Cancellation::default()).unwrap();
    assert_eq!(
        endpoint.replace("abandoned", &before, &before, &Cancellation::default()),
        Err(Error::Busy)
    );
    assert_eq!(endpoint.receipt("abandoned").unwrap(), None);
    assert!(lock.is_dir());
    assert_eq!(driver.applies.load(Ordering::SeqCst), 8);
}

#[cfg(unix)]
#[test]
fn actual_directory_modes_and_backup_manifests_roundtrip_both_endpoints() {
    use std::os::unix::fs::PermissionsExt;
    for use_remote in [false, true] {
        let home = Home::new();
        home.put(".config/opencode/skills/example/file", b"prior");
        let (remote, _) = remote(&home);
        let local = home.local();
        let endpoint: &dyn Endpoint = if use_remote { &remote } else { &local };
        let before = endpoint.read(&Cancellation::default()).unwrap();
        let mut after = alter(&before, "skills/example/file", b"next");
        after
            .iter_mut()
            .find(|e| e.name == "skills/example/")
            .unwrap()
            .mode = 0o750;
        endpoint
            .replace("modes", &before, &after, &Cancellation::default())
            .unwrap();
        assert_eq!(
            fs::metadata(home.0.join(".config/opencode/skills/example"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o750
        );
        let manifest = data(
            &home,
            ".config/opencode/.yuri.sync-runs/synthetic/modes/backup-manifest.json",
        );
        let manifest: Value = serde_json::from_slice(&manifest).unwrap();
        assert!(
            manifest
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["name"] == "skills/example/")
        );
        assert!(
            !String::from_utf8(serde_json::to_vec(&manifest).unwrap())
                .unwrap()
                .contains("prior")
        );
    }
}

#[cfg(unix)]
#[test]
fn preexisting_nonprivate_transaction_directories_are_not_trusted() {
    use std::os::unix::fs::PermissionsExt;
    for use_remote in [false, true] {
        let home = Home::new();
        home.put(".config/opencode/opencode.json", b"{}");
        let store = home.0.join(".config/opencode/.yuri.sync-runs");
        fs::create_dir(&store).unwrap();
        fs::set_permissions(&store, fs::Permissions::from_mode(0o755)).unwrap();
        let (remote, _) = remote(&home);
        let local = home.local();
        let endpoint: &dyn Endpoint = if use_remote { &remote } else { &local };
        let before = endpoint.read(&Cancellation::default()).unwrap();
        let after = alter(&before, "opencode.json", b"never");
        assert_eq!(
            endpoint.replace("unsafe-private", &before, &after, &Cancellation::default()),
            Err(Error::Invalid)
        );
        assert_eq!(data(&home, ".config/opencode/opencode.json"), b"{}");
    }
}
