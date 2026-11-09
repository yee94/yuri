use super::*;
use std::sync::atomic::AtomicUsize;

fn scope() -> Value {
    json!({"hostID":"synthetic-host", "lease":"00000000-0000-4000-8000-000000000001"})
}
fn file(name: &str, bytes: &[u8]) -> Selected {
    Selected {
        name: name.into(),
        mime: native::mime(name).into(),
        source: Source::Bytes(bytes.into()),
    }
}
struct Fake {
    current: AtomicBool,
    calls: AtomicUsize,
    mode: &'static str,
}
impl Fake {
    fn new(mode: &'static str) -> Self {
        Self {
            current: AtomicBool::new(true),
            calls: AtomicUsize::new(0),
            mode,
        }
    }
}
impl Transport for Fake {
    fn current(&self, value: &Value) -> bool {
        self.current.load(Ordering::Acquire) && value == &scope()
    }
    fn upload(&self, expected: &Value, upload: Upload, cancelled: &AtomicBool) -> UploadResult {
        assert_eq!(expected, &scope());
        assert!(upload.path.starts_with("/api/fs/prompt-attachments/"));
        assert!(upload.path.ends_with("?storage=temporary"));
        let count = self.calls.fetch_add(1, Ordering::Relaxed);
        assert!(
            !upload
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        );
        let header = |key| {
            upload
                .headers
                .iter()
                .find(|(k, _)| k == key)
                .unwrap()
                .1
                .clone()
        };
        assert_eq!(
            header("X-Yuri-Content-Length"),
            upload.bytes.len().to_string()
        );
        assert_eq!(
            header("X-Yuri-Sha256"),
            native::sha256(&upload.bytes).unwrap()
        );
        if self.mode == "unknown" {
            return UploadResult::Unknown;
        }
        if self.mode == "denied" {
            return UploadResult::Denied;
        }
        if self.mode == "failure" || self.mode == "partial" && count == 1 {
            return UploadResult::Response {
                status: 413,
                body: Value::Null,
            };
        }
        if self.mode == "switch" {
            self.current.store(false, Ordering::Release);
        }
        if self.mode == "cancel" {
            cancelled.store(true, Ordering::Release);
        }
        let body = json!({"success":true,"path": if self.mode == "windows" {"C:\\Temp\\synthetic #.txt"} else {"/synthetic/附件 #.txt"}, "size":upload.bytes.len(), "mime":header("X-Yuri-Mime"),"sha256":header("X-Yuri-Sha256")});
        if self.mode == "bad_receipt" {
            return UploadResult::Response {
                status: 200,
                body: json!({"success":true}),
            };
        }
        UploadResult::Response { status: 200, body }
    }
}
fn run(fake: &Fake, files: Vec<Selected>) -> Value {
    stage("pick_1", &scope(), &AtomicBool::new(false), fake, || {
        Ok(files)
    })
}

#[test]
fn real_digest_and_exact_upload_wire_and_attachment_model() {
    assert_eq!(
        native::sha256(b"abc").unwrap(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let fake = Fake::new("ready");
    let result = run(
        &fake,
        vec![
            file("附件 #.txt", b"hello"),
            file("photo.png", b"synthetic-image"),
        ],
    );
    assert_eq!(result["state"], "ready");
    assert_eq!(result["attachments"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["attachments"][0],
        json!({"uri":"file:///synthetic/%E9%99%84%E4%BB%B6%20%23.txt", "name":"附件 #.txt", "mime":"text/plain"})
    );
    assert_eq!(fake.calls.load(Ordering::Relaxed), 2);
    assert_eq!(
        run(&Fake::new("windows"), vec![file("note.txt", b"a")])["attachments"][0]["uri"],
        "file:///C:/Temp/synthetic%20%23.txt"
    );
}
#[test]
fn explicit_cancellation_and_stale_authority_never_pick_or_upload() {
    let fake = Fake::new("ready");
    fake.current.store(false, Ordering::Release);
    let output = stage("pick_1", &scope(), &AtomicBool::new(false), &fake, || {
        panic!("must not pick")
    });
    assert_eq!(output["state"], "retired");
    assert_eq!(fake.calls.load(Ordering::Relaxed), 0);
    let fake = Fake::new("ready");
    assert_eq!(run(&fake, vec![])["state"], "cancelled");
    assert_eq!(fake.calls.load(Ordering::Relaxed), 0);
    assert_eq!(
        stage(
            "pick_1",
            &scope(),
            &AtomicBool::new(true),
            &fake,
            || panic!("cancelled")
        )["state"],
        "retired"
    );
}
#[test]
fn denial_failure_unknown_and_partial_success_are_distinct_without_replay() {
    for (mode, state) in [
        ("denied", "failed"),
        ("failure", "failed"),
        ("unknown", "unknown"),
        ("bad_receipt", "unknown"),
    ] {
        let fake = Fake::new(mode);
        assert_eq!(
            run(&fake, vec![file("a.txt", b"a"), file("b.txt", b"b")])["state"],
            state
        );
        assert_eq!(fake.calls.load(Ordering::Relaxed), 1);
    }
    let fake = Fake::new("partial");
    let output = run(&fake, vec![file("a.txt", b"a"), file("b.txt", b"b")]);
    assert_eq!(output["state"], "failed");
    assert_eq!(output["attachments"].as_array().unwrap().len(), 1);
}
#[test]
fn late_success_is_not_adopted_and_no_unsafe_delete_is_attempted() {
    for mode in ["switch", "cancel"] {
        let fake = Fake::new(mode);
        let output = run(&fake, vec![file("a.txt", b"a"), file("b.txt", b"b")]);
        assert_eq!(output["state"], "retired");
        assert_eq!(output["attachments"], json!([]));
        assert_eq!(output["orphaned"], 1);
        assert_eq!(fake.calls.load(Ordering::Relaxed), 1);
    }
}
#[test]
fn bounds_and_metadata_fail_before_dispatch() {
    for files in [
        vec![file("../bad", b"x")],
        vec![file("empty", b"")],
        vec![file("big", &vec![0; FILE_LIMIT + 1])],
        (0..COUNT_LIMIT + 1).map(|_| file("a.txt", b"a")).collect(),
    ] {
        let fake = Fake::new("ready");
        assert_eq!(run(&fake, files)["state"], "failed");
        assert_eq!(fake.calls.load(Ordering::Relaxed), 0);
    }
    assert!(validate("a.txt", "text/plain\r\nAuthorization: bad", false).is_err());
    assert!(validate("a.txt", "text/plain", true).is_err());
    assert!(parse(&json!({"requestID":"pick_1","kind":"files","expectedHost":scope(),"path":"/host/secret"}),true).is_err());
    assert!(parse(&json!({"requestID":"pick_1","kind":"files"}), true).is_err());
    assert!(
        parse(
            &json!({"requestID":"pick_1","kind":"files","expectedHost":scope(),"bytes":[1]}),
            true
        )
        .is_err()
    );
}
#[test]
fn total_budget_is_shared_across_multiple_files() {
    let fake = Fake::new("ready");
    let output = run(
        &fake,
        vec![
            file("a.bin", &vec![0; FILE_LIMIT]),
            file("b.bin", &vec![0; FILE_LIMIT]),
            file("c.bin", b"x"),
        ],
    );
    assert_eq!(output["state"], "failed");
    assert_eq!(output["attachments"].as_array().unwrap().len(), 2);
    assert_eq!(fake.calls.load(Ordering::Relaxed), 2);
}

#[test]
fn hostchannel_multi_pick_receipt_readback_cancel_and_retry_fences_without_native_ui() {
    for mode in ["ready", "unknown"] {
        use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
        struct Sink;
        impl MountSink for Sink {
            fn submit(&self, _: nsh_core::MountBatch) {}
        }
        let host = HostChannel::default();
        let fake = Arc::new(Fake::new(mode));
        let (port, inbox) = channel();
        let owner = install(&host, fake.clone(), port);
        let (tx, rx) = mpsc::channel();
        host.handle("test.result", move |mut c| {
            tx.send(c.take_data()).unwrap();
        });
        let (pick_tx, pick_rx) = mpsc::channel();
        let ui = std::thread::spawn(move || {
            for _ in 0..5000 {
                if let Some(job) = inbox.try_recv() {
                    job.reply
                        .send(Ok(vec![file("a.txt", b"synthetic")]))
                        .unwrap();
                    pick_tx.send(()).unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            panic!("picker mailbox missing");
        });
        let source = r#"import {host} from 'nsh'; (async()=>{
      const expectedHost={hostID:'synthetic-host',lease:'00000000-0000-4000-8000-000000000001'};
      const args={requestID:'real_receipt',kind:'files',expectedHost};
      const picked=await host.call('desktop.attachments.pick',args);
      const read=await host.call('desktop.attachments.status',{requestID:args.requestID,expectedHost});
      let reused=false;try{await host.call('desktop.attachments.pick',args)}catch{reused=true}
      let localPath=false;try{await host.call('desktop.attachments.pick',{...args,requestID:'forged',path:'/host/secret'})}catch{localPath=true}
      let wrongScope=false;try{await host.call('desktop.attachments.status',{requestID:args.requestID,expectedHost:{...expectedHost,lease:'00000000-0000-4000-8000-000000000002'}})}catch{wrongScope=true}
      const released=await host.call('desktop.attachments.release',{requestID:args.requestID,expectedHost});
      host.post('test.result',{picked,read,reused,localPath,wrongScope,released});
    })().catch(e=>host.post('test.result',{error:String(e)}));"#;
        let mut bundle = Bundle::source(source.into());
        bundle.policy.declared =
            Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
        let mut config = EngineConfig::new(bundle);
        config.host = host;
        let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
        let output = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        ui.join().unwrap();
        pick_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(engine);
        drop(owner);
        assert_eq!(output["picked"]["state"], mode);
        assert_eq!(output["picked"], output["read"]);
        for key in ["reused", "localPath", "wrongScope"] {
            assert_eq!(output[key], true, "{key}: {output}");
        }
        assert_eq!(output["released"]["state"], "retired");
        assert_eq!(output["released"]["attachments"], json!([]));
        assert_eq!(
            output["released"]["orphaned"],
            if mode == "ready" { 1 } else { 0 }
        );
        assert_eq!(fake.calls.load(Ordering::Relaxed), 1);
    }
}

struct AssistantFake {
    calls: AtomicUsize,
    mode: &'static str,
}
impl Transport for AssistantFake {
    fn current(&self, value: &Value) -> bool {
        value == &scope()
    }
    fn upload(&self, expected: &Value, upload: Upload, cancelled: &AtomicBool) -> UploadResult {
        assert_eq!(expected, &scope());
        assert!(assistant_upload_path(&upload.path));
        assert!(
            upload
                .path
                .starts_with("/api/yuri/assistants/asst_a/contact/attachments/")
        );
        assert_eq!(upload.headers.len(), 4);
        let index = self.calls.fetch_add(1, Ordering::Relaxed);
        let header = |key: &str| {
            upload
                .headers
                .iter()
                .find(|(k, _)| k == key)
                .unwrap()
                .1
                .clone()
        };
        assert_eq!(
            header("X-Content-SHA256"),
            native::sha256(&upload.bytes).unwrap()
        );
        assert_eq!(header("X-Content-Size"), upload.bytes.len().to_string());
        assert!(
            !upload
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        );
        if self.mode == "unknown" {
            return UploadResult::Unknown;
        }
        if self.mode == "cancel" {
            cancelled.store(true, Ordering::Release);
        }
        if self.mode == "partial" && index == 1 {
            return UploadResult::Response {
                status: 413,
                body: Value::Null,
            };
        }
        let mut body = json!({"type":"file","attachmentID":format!("att_{index}"),"sha256":header("X-Content-SHA256"),"size":upload.bytes.len(),"mime":header("Content-Type")});
        match self.mode {
            "bad_hash" => body["sha256"] = json!("0".repeat(64)),
            "bad_size" => body["size"] = json!(upload.bytes.len() + 1),
            "bad_mime" => body["mime"] = json!("image/png"),
            "bad_id" => body["attachmentID"] = json!("../another"),
            "wrong_target" => body["assistantID"] = json!("asst_b"),
            "legacy" => body = json!({"success":true,"path":"/synthetic/note.txt"}),
            _ => {}
        }
        UploadResult::Response {
            status: if self.mode == "wrong_status" {
                200
            } else {
                201
            },
            body,
        }
    }
}
fn assistant_run(mode: &'static str, files: Vec<Selected>) -> (Value, usize) {
    let fake = AssistantFake {
        calls: AtomicUsize::new(0),
        mode,
    };
    let result = stage_target(
        "pick_a",
        &scope(),
        &Target::Assistant("asst_a".into()),
        &AtomicBool::new(false),
        &fake,
        || Ok(files),
    );
    (result, fake.calls.load(Ordering::Relaxed))
}
#[test]
fn assistant_upload_uses_exact_web_descriptor_without_local_file_or_byte_metadata() {
    let (output, calls) = assistant_run("ready", vec![file("附件 #.txt", &[0, 255, 13, 10])]);
    assert_eq!(calls, 1);
    assert_eq!(output["state"], "ready");
    assert_eq!(
        output["target"],
        json!({"kind":"assistant","assistantID":"asst_a"})
    );
    assert_eq!(
        output["attachments"][0]["uri"],
        "/api/yuri/assistants/asst_a/contact/attachments/att_0"
    );
    assert_eq!(output["attachments"][0]["name"], "附件 #.txt");
    assert_eq!(output["attachments"][0]["contact"]["assistantID"], "asst_a");
    assert_eq!(output["attachments"][0]["contact"]["size"], 4);
    assert!(!output.to_string().contains("file://"));
    assert!(!output.to_string().contains("bytes"));
}
#[test]
fn assistant_bad_descriptor_or_unknown_never_replays_or_guesses_paths() {
    for mode in [
        "bad_hash",
        "bad_size",
        "bad_mime",
        "bad_id",
        "wrong_target",
        "legacy",
        "wrong_status",
        "unknown",
    ] {
        let (output, calls) = assistant_run(mode, vec![file("a.txt", b"a"), file("b.txt", b"b")]);
        assert_eq!(output["state"], "unknown", "{mode}: {output}");
        assert_eq!(output["attachments"], json!([]));
        assert_eq!(calls, 1);
    }
}
#[test]
fn assistant_partial_success_and_late_cancel_keep_receipts_and_orphan_accounting() {
    let (partial, calls) = assistant_run("partial", vec![file("a.txt", b"a"), file("b.txt", b"b")]);
    assert_eq!(partial["state"], "failed");
    assert_eq!(partial["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(calls, 2);
    let (cancelled, calls) =
        assistant_run("cancel", vec![file("a.txt", b"a"), file("b.txt", b"b")]);
    assert_eq!(cancelled["state"], "retired");
    assert_eq!(cancelled["attachments"], json!([]));
    assert_eq!(cancelled["orphaned"], 1);
    assert_eq!(calls, 1);
}
#[test]
fn assistant_count_hash_and_byte_boundaries_reuse_native_budgets() {
    let (output, calls) = assistant_run("ready", (0..64).map(|_| file("a.txt", b"a")).collect());
    assert_eq!(output["state"], "ready");
    assert_eq!(calls, 64);
    for files in [
        vec![file("a.txt", b"")],
        vec![file("a.txt", &vec![0; FILE_LIMIT + 1])],
        (0..65).map(|_| file("a.txt", b"a")).collect(),
    ] {
        let (output, calls) = assistant_run("ready", files);
        assert_eq!(output["state"], "failed");
        assert_eq!(calls, 0);
    }
    let (output, calls) = assistant_run(
        "ready",
        vec![
            file("a.bin", &vec![0; FILE_LIMIT]),
            file("b.bin", &vec![0; FILE_LIMIT]),
            file("c.txt", b"x"),
        ],
    );
    assert_eq!(output["state"], "failed");
    assert_eq!(calls, 2);
    assert_eq!(output["attachments"].as_array().unwrap().len(), 2);
}
#[test]
fn assistant_targets_are_explicit_narrow_and_no_arbitrary_put_or_message_claim_is_admitted() {
    for target in [
        Value::Null,
        json!({}),
        json!({"kind":"assistant"}),
        json!({"kind":"assistant","assistantID":"../a"}),
        json!({"kind":"assistant","assistantID":"asst_a","writer":true}),
        json!({"kind":"session","assistantID":"asst_a"}),
    ] {
        assert!(parse(&json!({"requestID":"pick_a","kind":"files","expectedHost":scope(),"target":target}), true).is_err());
    }
    assert_eq!(Target::parse(None).unwrap(), Target::Session);
    for path in [
        "/api/yuri/assistants/asst_a/messages",
        "/api/yuri/assistants/asst_a/contact/attachments/x",
        "/api/yuri/assistants/asst_a/contact/attachments/00000000-0000-4000-8000-000000000001?target=asst_b",
        "/api/yuri/assistants/asst%2Fa/contact/attachments/00000000-0000-4000-8000-000000000001",
    ] {
        assert!(!assistant_upload_path(path), "{path}");
    }
}
