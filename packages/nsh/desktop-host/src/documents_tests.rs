use super::*;
use std::{fs, path::PathBuf, time::Duration};
fn scope() -> Value {
    json!({"hostID":"synthetic", "lease":"00000000-0000-4000-8000-000000000001"})
}
fn args(id: &str) -> Value {
    json!({"requestID":id,"ownerID":"sidebar_export_1","expectedHost":scope(),"format":"markdown","filename":"synthetic.md","content":"# Synthetic\n\n仅合成正文"})
}
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::var_os("NSH_DOCUMENTS_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let root = root
            .canonicalize()
            .unwrap()
            .join(format!("documents-{}", crate::vault::id().unwrap()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn payload_bounds_and_strict_local_metadata_no_path_or_credentials() {
    assert!(parse(&args("save_1"), true).is_ok());
    for (key, value) in [
        ("path", json!("/host/not-a-client-path")),
        ("url", json!("https://example.invalid")),
        ("credential", json!("synthetic-not-real")),
    ] {
        let mut input = args("save_1");
        input[key] = value;
        assert!(parse(&input, true).is_err());
    }
    for filename in ["../note.md", "C:\\note.md", ".hidden.md", "x.txt", "x\n.md"] {
        let mut v = args("save_1");
        v["filename"] = json!(filename);
        assert!(parse(&v, true).is_err());
    }
    let mut v = args("save_1");
    v["content"] = json!("x".repeat(CONTENT_LIMIT));
    assert!(parse(&v, true).is_ok());
    v["content"] = json!("界".repeat(CONTENT_LIMIT / 3 + 1));
    assert!(parse(&v, true).is_err());
    let mut v = args("save_1");
    v["content"] = json!("");
    assert!(parse(&v, true).is_err());
}
#[test]
fn isolated_temp_atomic_save_and_explicit_overwrite_preserve_prior_until_commit() {
    let temp = Temp::new();
    let path = temp.0.join("synthetic.md");
    fs::write(&path, b"Prior synthetic content").unwrap();
    let grant = files::Grant::selected(&path).unwrap();
    let bytes = "# 新的合成 Markdown\n".as_bytes();
    let mut stage = grant.stage(bytes, || true).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"Prior synthetic content");
    grant.commit(&mut stage).unwrap();
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert!(grant.verify(bytes).unwrap());
    drop(stage);
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    let path = temp.0.join("new.md");
    let grant = files::Grant::selected(&path).unwrap();
    let mut stage = grant.stage(b"new", || true).unwrap();
    grant.commit(&mut stage).unwrap();
    assert_eq!(fs::read(path).unwrap(), b"new");
}
#[test]
fn cancellation_and_observed_external_edits_leave_original_and_cleanup_only_own_stage() {
    let temp = Temp::new();
    let path = temp.0.join("synthetic.md");
    fs::write(&path, b"prior").unwrap();
    let grant = files::Grant::selected(&path).unwrap();
    assert!(grant.stage(b"not written", || false).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"prior");
    let calls = std::cell::Cell::new(0);
    assert!(
        grant
            .stage(&vec![b'x'; 131072], || {
                let count = calls.get();
                calls.set(count + 1);
                count == 0
            })
            .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), b"prior");
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    let mut stage = grant.stage(b"new", || true).unwrap();
    fs::write(&path, b"another writer changed length").unwrap();
    assert_eq!(
        grant.commit(&mut stage).unwrap_err(),
        "documents_target_changed"
    );
    drop(stage);
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    assert_eq!(fs::read(&path).unwrap(), b"another writer changed length");
    let missing = temp.0.join("was-missing.md");
    let grant = files::Grant::selected(&missing).unwrap();
    let mut stage = grant.stage(b"new", || true).unwrap();
    fs::write(&missing, b"created concurrently").unwrap();
    assert_eq!(
        grant.commit(&mut stage).unwrap_err(),
        "documents_target_changed"
    );
    assert_eq!(fs::read(missing).unwrap(), b"created concurrently");
}
#[cfg(target_os = "macos")]
#[test]
fn refuses_symlinks_hardlinks_special_files_and_link_parents_without_following() {
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::symlink},
    };
    let temp = Temp::new();
    let real = temp.0.join("real.md");
    fs::write(&real, b"unchanged").unwrap();
    let link = temp.0.join("link.md");
    symlink(&real, &link).unwrap();
    assert!(files::Grant::selected(&link).is_err());
    let hard = temp.0.join("hard.md");
    fs::hard_link(&real, &hard).unwrap();
    assert!(files::Grant::selected(&hard).is_err());
    assert!(files::Grant::selected(&temp.0).is_err());
    let parent = temp.0.join("link-parent");
    symlink(&temp.0, &parent).unwrap();
    assert!(files::Grant::selected(&parent.join("new.md")).is_err());
    unsafe extern "C" {
        fn mkfifo(path: *const std::ffi::c_char, mode: u32) -> i32;
    }
    let fifo = temp.0.join("pipe.md");
    let c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { mkfifo(c.as_ptr(), 0o600) }, 0);
    assert!(files::Grant::selected(&fifo).is_err());
    assert_eq!(fs::read(real).unwrap(), b"unchanged");
}
#[test]
fn hostchannel_exact_ids_cancel_retire_and_unknown_status_use_injected_panel_only() {
    use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
    struct Sink;
    impl MountSink for Sink {
        fn submit(&self, _: nsh_core::MountBatch) {}
    }
    for mode in ["saved", "cancelled", "retired", "unknown"] {
        let temp = Temp::new();
        let path = temp.0.join("synthetic.md");
        let panel_path = path.clone();
        let host = HostChannel::default();
        let current = Arc::new(AtomicBool::new(true));
        let predicate = current.clone();
        let (port, inbox) = channel();
        let owner = install(
            &host,
            Arc::new(move |v| predicate.load(Ordering::Acquire) && *v == scope()),
            port,
        );
        let (tx, rx) = mpsc::channel();
        host.handle("test.result", move |mut call| {
            tx.send(call.take_data()).unwrap();
        });
        let (drive, driven) = mpsc::channel();
        host.handle("test.drive", move |mut call| {
            drive.send(call.take_data()).unwrap();
        });
        let script = format!(
            r#"import {{host}} from 'nsh'; (async()=>{{
          const input={input}; const control={{requestID:input.requestID,ownerID:input.ownerID,expectedHost:input.expectedHost}};
          const saving=host.call('desktop.documents.save',input);
          const initial=await host.call('desktop.documents.status',control);
          let reused=false;try{{await host.call('desktop.documents.save',input)}}catch{{reused=true}}
          let forged=false;try{{await host.call('desktop.documents.save',{{...input,requestID:'forged',path:'/host/path'}})}}catch{{forged=true}}
          let ownerFence=false;try{{await host.call('desktop.documents.status',{{...control,ownerID:'another_owner'}})}}catch{{ownerFence=true}}
          if('{mode}'==='cancelled')await host.call('desktop.documents.cancel',control);
          host.post('test.drive',{{}}); const result=await saving;
          const status='{mode}'==='retired'?null:await host.call('desktop.documents.status',control);
          host.post('test.result',{{initial,result,status,reused,forged,ownerFence}});
        }})().catch(e=>host.post('test.result',{{error:String(e)}}));"#,
            input = args("save_1")
        );
        let mut bundle = Bundle::source(script);
        bundle.policy.declared =
            Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
        let mut config = EngineConfig::new(bundle);
        config.host = host;
        let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
        driven.recv_timeout(Duration::from_secs(10)).unwrap();
        let mut job = inbox.try_recv().expect("one native mailbox job");
        if mode == "retired" {
            owner.invalidate();
            current.store(false, Ordering::Release);
        }
        if mode == "unknown" {
            fs::write(&panel_path, job.content.as_ref().unwrap()).unwrap();
            let grant = files::Grant::selected(&panel_path).unwrap();
            let content = job.content.take().unwrap();
            job.complete(
                receipt("save_1", "error", Some("documents_write_unknown")),
                Some(Verification { grant, content }),
            );
        } else {
            job.test_panel(|| {
                if mode == "cancelled" || mode == "retired" {
                    panic!("retired job must not open panel");
                }
                Ok(Some(panel_path))
            });
        }
        let modified = path.metadata().ok().and_then(|value| value.modified().ok());
        let output = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if mode == "unknown" {
            assert_eq!(path.metadata().unwrap().modified().ok(), modified);
        }
        assert!(inbox.try_recv().is_none());
        drop(engine);
        drop(owner);
        assert_eq!(output["initial"]["state"], "pending");
        assert_eq!(
            output["result"]["state"],
            if mode == "unknown" {
                "error"
            } else if mode == "retired" {
                "cancelled"
            } else {
                mode
            }
        );
        for key in ["reused", "forged", "ownerFence"] {
            assert_eq!(output[key], true, "{key}");
        }
        if mode == "unknown" || mode == "saved" {
            assert_eq!(output["status"]["state"], "saved");
            assert_eq!(
                fs::read(&path).unwrap(),
                args("save_1")["content"].as_str().unwrap().as_bytes()
            );
        } else {
            assert!(!path.exists());
        }
        assert!(output["result"].get("path").is_none());
        assert!(output["result"].get("content").is_none());
    }
}

#[test]
fn actual_hostchannel_accepts_exact_eight_mib_and_rejects_oversize_before_queuing() {
    use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
    struct Sink;
    impl MountSink for Sink {
        fn submit(&self, _: nsh_core::MountBatch) {}
    }
    let host = HostChannel::default();
    let (port, inbox) = channel();
    let _owner = install(&host, Arc::new(|v| *v == scope()), port);
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let script = format!(
        r#"import {{host}} from 'nsh'; (async()=>{{
      const input={input}; let rejected=false;
      try{{await host.call('desktop.documents.save',{{...input,requestID:'too_large',content:'x'.repeat(8*1024*1024+1)}})}}catch{{rejected=true}}
      const result=await host.call('desktop.documents.save',{{...input,content:'x'.repeat(8*1024*1024)}});
      host.post('test.result',{{rejected,result}});
    }})().catch(e=>host.post('test.result',{{error:String(e)}}));"#,
        input = args("bounded")
    );
    let mut bundle = Bundle::source(script);
    bundle.policy.declared =
        Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    let start = std::time::Instant::now();
    let job = loop {
        if let Some(job) = inbox.try_recv() {
            break job;
        }
        assert!(start.elapsed() < Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(1));
    };
    assert_eq!(job.content.as_ref().unwrap().len(), CONTENT_LIMIT);
    job.test_panel(|| Ok(None));
    let output = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    drop(engine);
    assert_eq!(output["rejected"], true);
    assert_eq!(output["result"]["state"], "cancelled");
    assert!(inbox.try_recv().is_none());
}

#[test]
fn receipt_tombstones_are_bounded_and_never_evicted_or_reused() {
    use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
    struct Sink;
    impl MountSink for Sink {
        fn submit(&self, _: nsh_core::MountBatch) {}
    }
    let host = HostChannel::default();
    let (port, inbox) = channel();
    let owner = install(&host, Arc::new(|v| *v == scope()), port);
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let script = format!(
        r#"import {{host}} from 'nsh';(async()=>{{
      const input={input};for(let i=0;i<128;i++)await host.call('desktop.documents.save',{{...input,requestID:'save_'+i}});
      let full=false,reused=false;try{{await host.call('desktop.documents.save',{{...input,requestID:'overflow'}})}}catch{{full=true}}
      try{{await host.call('desktop.documents.save',{{...input,requestID:'save_0',filename:'different.md',content:'# Different target forbidden'}})}}catch{{reused=true}}
      host.post('test.result',{{full,reused}});
    }})().catch(e=>host.post('test.result',{{error:String(e)}}));"#,
        input = args("unused")
    );
    let mut bundle = Bundle::source(script);
    bundle.policy.declared =
        Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    for _ in 0..RECEIPTS {
        let start = std::time::Instant::now();
        let job = loop {
            if let Some(job) = inbox.try_recv() {
                break job;
            }
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(1));
        };
        job.test_panel(|| Ok(None));
    }
    let output = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    drop(engine);
    assert_eq!(output["full"], true);
    assert_eq!(output["reused"], true);
    assert_eq!(owner.book.lock().unwrap().receipts.len(), RECEIPTS);
    assert!(inbox.try_recv().is_none());
}
