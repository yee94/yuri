use super::*;
use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
use std::{fs, path::PathBuf, time::Duration};
struct Sink;
impl MountSink for Sink {
    fn submit(&self, _: nsh_core::MountBatch) {}
}
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("download-test-{}", crate::vault::id().unwrap()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn exact_host_only_payload_rejects_js_destination_credentials_and_urls() {
    let good = json!({"requestID":"request","ownerID":"owner","expectedHost":{"hostID":"synthetic","lease":"00000000-0000-4000-8000-000000000001"},"path":"/workspace/a.bin"});
    assert!(parse(&good, true).is_ok());
    for field in ["destination", "token", "content", "url"] {
        let mut v = good.clone();
        v[field] = json!("forbidden");
        assert!(parse(&v, true).is_err());
    }
    let mut url = good;
    url["path"] = json!("file:///local/private");
    assert!(parse(&url, true).is_err());
}
#[test]
fn real_hostchannel_saves_raw_binary_only_to_injected_system_destination_without_ui_or_js_bytes() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    let host = HostChannel::default();
    let (port, inbox) = channel();
    let owner = install(
        &host,
        Arc::new(|_| true),
        Arc::new(|_, path, limit| {
            assert_eq!(path, "/host/not/a/client/path.bin");
            assert_eq!(limit, LIMIT);
            Ok(vec![0, 255, 13, 10, 0, 128])
        }),
        port,
    );
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut c| {
        tx.send(c.take_data()).unwrap();
    });
    let mut bundle=Bundle::source("import {host} from 'nsh';host.call('desktop.files.download.save',{requestID:'r',ownerID:'o',expectedHost:{hostID:'synthetic',lease:'00000000-0000-4000-8000-000000000001'},path:'/host/not/a/client/path.bin'}).then(v=>host.post('test.result',v)).catch(e=>host.post('test.result',{error:String(e)}));".into());
    bundle.policy.declared =
        Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let job = loop {
        if let Some(job) = inbox.try_recv() {
            break job;
        }
        assert!(std::time::Instant::now() < deadline, "download job timeout");
        std::thread::sleep(Duration::from_millis(5));
    };
    job.write(dest.clone());
    let result = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(result["state"], "saved", "{result}");
    assert_eq!(fs::read(dest).unwrap(), [0, 255, 13, 10, 0, 128]);
    assert_eq!(result.as_object().unwrap().len(), 2);
    drop(engine);
    drop(owner);
}
#[test]
fn cancelled_native_grant_never_reads_source_or_overwrites_prior() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let book = Arc::new(Mutex::new(Book::default()));
    let cancelled = Arc::new(AtomicBool::new(true));
    let job = Job {
        id: "r".into(),
        filename: "a.bin".into(),
        path: "/host/path".into(),
        scope: json!({}),
        source: Arc::new(|_, _, _| panic!("must not read")),
        authority: Arc::new(|_| true),
        cancelled,
        stopped: Arc::new(AtomicBool::new(false)),
        book,
        reply: None,
        finished: false,
    };
    job.write(dest.clone());
    assert_eq!(fs::read(dest).unwrap(), b"prior");
}
