//! Real attachment HostChannel -> private selected bytes -> original actor, no OS or real Host.
use super::*;
use nsh_engine::{Bundle, Engine, EngineConfig, FetchEvents, MountSink};
use std::sync::Mutex;

#[derive(Clone, Default)]
struct MemoryVault(Arc<Mutex<Option<Vec<u8>>>>);
impl Vault for MemoryVault {
    fn read(&self) -> Result<Option<Vec<u8>>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn write(&self, bytes: &[u8]) -> Result<()> {
        *self.0.lock().unwrap() = Some(bytes.to_vec());
        Ok(())
    }
}
struct Task;
impl FetchTask for Task {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {}
}
struct PendingResponse {
    events: FetchEvents,
    url: String,
    body: Value,
}
impl PendingResponse {
    fn complete(mut self) {
        (self.events)(FetchEvent::Head(HttpHead {
            status: 201,
            url: self.url,
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }));
        (self.events)(FetchEvent::Data(serde_json::to_vec(&self.body).unwrap()));
        (self.events)(FetchEvent::End);
    }
}
#[derive(Default)]
struct Recorded {
    requests: Vec<HttpRequest>,
    pending: Vec<PendingResponse>,
    waiting: Option<HostReply>,
}
struct SyntheticNetwork {
    mode: &'static str,
    state: Mutex<Recorded>,
}
impl SyntheticNetwork {
    fn complete(&self) {
        let pending = std::mem::take(&mut self.state.lock().unwrap().pending);
        for response in pending {
            response.complete();
        }
    }
    fn await_dispatch(&self, reply: HostReply) {
        let mut state = self.state.lock().unwrap();
        if state.requests.is_empty() {
            state.waiting = Some(reply);
        } else {
            reply.resolve(json!(true));
        }
    }
}
impl Network for SyntheticNetwork {
    fn fetch(&self, request: HttpRequest, events: FetchEvents) -> Box<dyn FetchTask> {
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .unwrap()
                .1
                .clone()
        };
        let bytes = match &request.body {
            nsh_engine::HttpBody::Bytes(bytes) => bytes,
            _ => panic!("must be raw native bytes"),
        };
        assert_eq!(bytes, &[0, 255, 13, 10, 65]);
        assert_eq!(
            request
                .url
                .split("host.invalid")
                .nth(1)
                .unwrap()
                .split('/')
                .take(7)
                .collect::<Vec<_>>(),
            vec![
                "",
                "api",
                "yuri",
                "assistants",
                "asst_a",
                "contact",
                "attachments"
            ]
        );
        assert_eq!(request.method, "PUT");
        assert!(!request.follow_redirects);
        assert_eq!(header("Authorization"), "Bearer synthetic-test-token");
        assert_eq!(header("X-Content-Size"), bytes.len().to_string());
        assert_eq!(header("X-Attachment-Filename"), "synthetic.bin");
        assert!(
            !request
                .headers
                .iter()
                .any(|(name, _)| name.to_ascii_lowercase().starts_with("x-yuri-"))
        );
        let body = json!({"type":"file","attachmentID":"att_native","sha256":if self.mode == "bad_hash" { "a".repeat(64) } else { header("X-Content-SHA256") },"size":bytes.len(),"mime":header("Content-Type"),"filename":"synthetic.bin"});
        let response = PendingResponse {
            events,
            url: request.url.clone(),
            body,
        };
        let mut state = self.state.lock().unwrap();
        state.requests.push(request);
        if let Some(waiting) = state.waiting.take() {
            waiting.resolve(json!(true));
        }
        if self.mode.starts_with("hold_") {
            state.pending.push(response);
        } else {
            drop(state);
            response.complete();
        }
        Box::new(Task)
    }
}
fn connection() -> Connection {
    Connection {
        id: "synthetic-host".into(),
        label: "Synthetic".into(),
        url: "https://host.invalid".into(),
        token: "synthetic-test-token".into(),
        used: 1.0,
        authorization: "synthetic-authorization".into(),
        editor_version: None,
    }
}
fn saved() -> State {
    let mut state = State {
        connections: vec![connection()],
        selected: Some("synthetic-host".into()),
        scope: None,
        notification_retirements: vec![],
        notification_error: None,
        native: Default::default(),
        extra: Default::default(),
    };
    state.rotate().unwrap();
    state
}
struct Sink;
impl MountSink for Sink {
    fn submit(&self, _: nsh_core::MountBatch) {}
}

struct PrivateFile {
    directory: std::path::PathBuf,
    path: std::path::PathBuf,
}
impl PrivateFile {
    fn new() -> Self {
        use std::io::Write;
        let directory =
            std::env::temp_dir().join(format!("synthetic-attachment-{}", vault::id().unwrap()));
        std::fs::create_dir(&directory).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let path = directory.join("synthetic.bin");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).unwrap();
        file.write_all(&[0, 255, 13, 10, 65]).unwrap();
        Self { directory, path }
    }
}
impl Drop for PrivateFile {
    fn drop(&mut self) {
        std::fs::remove_file(&self.path).unwrap();
        std::fs::remove_dir(&self.directory).unwrap();
    }
}

#[test]
fn assistant_hostchannel_raw_actor_target_receipts_cancel_unknown_and_host_lease_without_ui() {
    for mode in ["ready", "bad_hash", "hold_cancel", "hold_switch"] {
        let private = PrivateFile::new();
        let picker_path = private.path.clone();
        let host = HostChannel::default();
        let store = MemoryVault::default();
        saved().persist(&store).unwrap();
        let network = Arc::new(SyntheticNetwork {
            mode,
            state: Mutex::new(Recorded::default()),
        });
        let caps = json!({"host":["connection.list","connection.select","desktop.attachments.pick","desktop.attachments.status","desktop.attachments.cancel","desktop.attachments.release","test.dispatched","test.complete","test.result"]});
        let mut owner =
            install_with(&host, &caps, Box::new(store), network.clone(), false).unwrap();
        let (port, inbox) = attachments::channel();
        owner.install_attachments(&host, port).unwrap();
        let ready_network = network.clone();
        host.handle("test.dispatched", move |call| {
            ready_network.await_dispatch(call.into_reply().unwrap());
        });
        let response_network = network.clone();
        host.handle("test.complete", move |call| {
            response_network.complete();
            call.into_reply().unwrap().resolve(json!(true));
        });
        let (tx, rx) = mpsc::channel();
        host.handle("test.result", move |mut call| {
            tx.send(call.take_data()).unwrap();
        });
        let picker = std::thread::spawn(move || {
            for _ in 0..5000 {
                if let Some(job) = inbox.try_recv() {
                    job.complete_private_file_for_test(picker_path);
                    return;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            panic!("missing actual picker inbox job");
        });
        let in_flight = match mode {
            "hold_cancel" => {
                "await host.call('test.dispatched',{}); await host.call('desktop.attachments.cancel',identity); await host.call('test.complete',{});"
            }
            "hold_switch" => {
                "await host.call('test.dispatched',{}); await host.call('connection.select',{id:saved.selected}); await host.call('test.complete',{});"
            }
            _ => "",
        };
        let source = format!(
            r#"import {{host}} from 'nsh'; (async()=>{{
          const saved=await host.call('connection.list',{{}}), expectedHost=saved.runtimeScope;
          const target={{kind:'assistant',assistantID:'asst_a'}},identity={{requestID:'assistant_native',expectedHost,target}};
          const flight=host.call('desktop.attachments.pick',{{...identity,kind:'files'}});
          {in_flight}
          const picked=await flight;
          let foreign=0;
          for(const method of ['status','cancel','release']){{
            for(const target of [undefined,{{kind:'assistant',assistantID:'asst_b'}}]){{
              try{{await host.call('desktop.attachments.'+method,{{...identity,target}});}}catch{{foreign++;}}
            }}
          }}
          let wrongLease=false;try{{await host.call('desktop.attachments.status',{{...identity,expectedHost:{{...expectedHost,lease:'00000000-0000-4000-8000-000000000099'}}}})}}catch{{wrongLease=true}}
          let read;for(let i=0;i<50;i++)read=await host.call('desktop.attachments.status',identity);
          let reused=false;try{{await host.call('desktop.attachments.pick',{{...identity,kind:'files'}})}}catch{{reused=true}}
          const released=await host.call('desktop.attachments.release',identity);
          host.post('test.result',{{picked,read,foreign,wrongLease,reused,released}});
        }})().catch(e=>host.post('test.result',{{error:String(e)}}));"#
        );
        let mut bundle = Bundle::source(source);
        bundle.policy.declared = Some(nsh_core::access::Capabilities::from_json(&caps).unwrap());
        let mut config = EngineConfig::new(bundle);
        config.host = host;
        let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
        let output = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        picker.join().unwrap();
        assert_eq!(output["foreign"], 6, "{mode}: {output}");
        assert_eq!(output["wrongLease"], true);
        assert_eq!(output["reused"], true);
        let expected = match mode {
            "ready" => "ready",
            "hold_cancel" => "retired",
            _ => "unknown",
        };
        assert_eq!(output["picked"]["state"], expected, "{mode}: {output}");
        assert_eq!(
            output["picked"]["target"],
            json!({"kind":"assistant","assistantID":"asst_a"})
        );
        if mode == "ready" {
            assert_eq!(output["picked"], output["read"]);
            assert_eq!(
                output["picked"]["attachments"][0]["contact"]["attachmentID"],
                "att_native"
            );
            assert_eq!(output["released"]["orphaned"], 1);
        } else {
            assert_eq!(output["picked"]["attachments"], json!([]));
            if mode == "hold_cancel" {
                assert_eq!(output["picked"]["orphaned"], 1);
            }
        }
        assert_eq!(
            network.state.lock().unwrap().requests.len(),
            1,
            "status/cancel/release must not replay bytes"
        );
        assert!(!output.to_string().contains("synthetic-test-token"));
        assert!(!output.to_string().contains("file://"));
        assert!(!output.to_string().contains(private.path.to_str().unwrap()));
        drop(engine);
        drop(owner);
    }
}

fn upload() -> Upload {
    Upload {
        path:
            "/api/yuri/assistants/asst_a/contact/attachments/00000000-0000-4000-8000-000000000001"
                .into(),
        headers: vec![
            ("Content-Type".into(), "application/octet-stream".into()),
            ("X-Content-Size".into(), "1".into()),
            ("X-Content-SHA256".into(), "a".repeat(64)),
            ("X-Attachment-Filename".into(), "synthetic.bin".into()),
        ],
        bytes: vec![0],
    }
}
#[test]
fn assistant_raw_upload_actor_policy_is_not_an_arbitrary_put_or_header_capability() {
    let (_, request) = request(&connection(), upload()).unwrap();
    assert_eq!(request.method, "PUT");
    assert!(!request.follow_redirects);
    for path in [
        "/api/yuri/assistants/asst_a/messages",
        "/api/yuri/assistants/asst_a/contact/attachments/../x",
        "/api/yuri/assistants/asst_a/contact/attachments/00000000-0000-4000-8000-000000000001?target=asst_b",
    ] {
        let mut value = upload();
        value.path = path.into();
        assert!(super::request(&connection(), value).is_err());
    }
    for key in [
        "Authorization",
        "X-Yuri-Content-Length",
        "Cookie",
        "Location",
    ] {
        let mut value = upload();
        value.headers[1].0 = key.into();
        assert!(super::request(&connection(), value).is_err());
    }
    let mut value = upload();
    value.headers[1].1 = "2".into();
    assert!(super::request(&connection(), value).is_err());
    let mut value = upload();
    value.headers[2].1 = "A".repeat(64);
    assert!(super::request(&connection(), value).is_err());
}
