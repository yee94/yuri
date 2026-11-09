//! Production installer/committed Reader/HostChannel. No chooser or user paths.
use super::*;
use crate::file_download::{self, transport};

#[test]
fn canonical_download_production_actor_capture_stage_and_same_id_late_authority_fence() {
    type Hook = Arc<Mutex<Option<Box<dyn Fn() + Send>>>>;
    struct CanonicalNetwork {
        hook: Hook,
        count: Arc<AtomicUsize>,
    }
    impl Network for CanonicalNetwork {
        fn fetch(
            &self,
            request: HttpRequest,
            mut events: nsh_engine::FetchEvents,
        ) -> Box<dyn FetchTask> {
            assert_eq!(request.method, "GET");
            assert_eq!(
                request.url,
                "https://host.invalid/api/yuri/assistants/bot.A/contact/attachments/att.1"
            );
            assert!(!request.follow_redirects);
            assert!(
                request
                    .headers
                    .contains(&("Authorization".into(), "Bearer synthetic-test-token".into()))
            );
            assert!(request.body.is_empty());
            self.count.fetch_add(1, Ordering::Relaxed);
            events(FetchEvent::Head(HttpHead {
                status: 200,
                url: request.url,
                headers: vec![
                    ("Content-Length".into(), "3".into()),
                    ("Content-Type".into(), "text/plain".into()),
                ],
                ..Default::default()
            }));
            events(FetchEvent::Data(b"abc".to_vec()));
            if let Some(hook) = self.hook.lock().unwrap().take() {
                hook();
            }
            events(FetchEvent::End);
            Box::new(FakeTask(Arc::new(AtomicUsize::new(0))))
        }
    }
    for cause in ["none", "authorization", "origin", "lease"] {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "canonical-native-download-{}",
            vault::id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let dest = root.join("chosen.txt");
        std::fs::write(&dest, b"prior").unwrap();
        let vault = MemoryVault::default();
        state().persist(&vault).unwrap();
        let hook: Hook = Arc::new(Mutex::new(None));
        let count = Arc::new(AtomicUsize::new(0));
        let network = Arc::new(CanonicalNetwork {
            hook: hook.clone(),
            count: count.clone(),
        });
        let host = HostChannel::default();
        let mut caps = file_download::METHODS.to_vec();
        caps.push("connection.list");
        let owner = install_with(
            &host,
            &json!({"host":caps}),
            Box::new(vault),
            network,
            false,
        )
        .unwrap();
        let services = owner.services();
        let (port, inbox) = file_download::channel();
        services.install_file_download(&host, port).unwrap();
        let inbox = Arc::new(Mutex::new(inbox));
        let jobs = inbox.clone();
        let selected = dest.clone();
        host.handle("test.write", move |call| {
            let job = jobs.lock().unwrap().try_recv().unwrap();
            let selected = selected.clone();
            let reply = call.into_reply().unwrap();
            std::thread::spawn(move || {
                job.complete_private_file_for_test(&selected);
                reply.resolve(json!(true));
            });
        });
        let published = services.clone();
        host.handle("test.configure", move |mut call| {
            let scope = call.take_data();
            let published = published.clone();
            if cause != "none" {
                *hook.lock().unwrap() = Some(Box::new(move || {
                    let mut scope = scope.clone();
                    if cause == "lease" {
                        scope["lease"] = json!("00000000-0000-4000-8000-000000000099");
                    }
                    published.publish(
                        &scope,
                        if cause == "origin" {
                            "https://replacement.invalid"
                        } else {
                            "https://host.invalid"
                        },
                        "replacement-synthetic-token",
                        "replacement-authorization",
                        false,
                    );
                }));
            }
            call.resolve(json!(true));
        });
        let (tx, rx) = mpsc::channel();
        host.handle("test.result", move |mut call| {
            tx.send(call.take_data()).unwrap();
        });
        let script = r#"import {host} from 'nsh';(async()=>{
            const check=(v,m)=>{if(!v)throw Error(m);}; const scope=(await host.call('connection.list',{})).runtimeScope;
            const cap=await host.call('desktop.files.download.capabilities',{source:'assistantAttachment'});
            const identity={ownerID:'owner',requestID:'request',windowID:cap.windowID,expectedHost:scope};
            await host.call('test.configure',scope);
            await host.call('desktop.files.download.save',{...identity,source:'assistantAttachment',attachment:{
                type:'file',assistantID:'bot.A',attachmentID:'att.1',sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',size:3,mime:'text/plain'}});
            await host.call('test.write',{});
            let state='stale';try{state=(await host.call('desktop.files.download.status',identity)).state;}catch{}
            host.post('test.result',{state});
        })().catch(error=>host.post('test.result',{error:String(error)}));"#;
        let engine = engine(host, script.into());
        let value = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            value,
            json!({"state":if cause=="none" {"saved"} else if cause=="lease" {"stale"} else {"cancelled"}})
        );
        assert_eq!(count.load(Ordering::Relaxed), 1);
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            if cause == "none" {
                b"abc".as_slice()
            } else {
                b"prior".as_slice()
            }
        );
        drop(engine);
        drop(owner);
        drop(services);
        drop(inbox);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn download_reader_is_exact_window_origin_authorization_and_suspension_fenced() {
    let services = crate::host_services::Port::new(Arc::new(FakeNetwork::default()));
    let window = services.window_id().unwrap();
    let reader = services.reader();
    let scope =
        json!({"hostID":"synthetic-download","lease":"00000000-0000-4000-8000-000000000001"});
    assert!(reader.capture_download(&scope, &window).is_err());
    services.publish(
        &scope,
        "https://synthetic.invalid",
        "synthetic-token",
        "authorization-first",
        false,
    );
    let first = reader.capture_download(&scope, &window).unwrap();
    assert!(first.valid());
    assert!(reader.capture_download(&scope, "another-window").is_err());
    services.publish(
        &scope,
        "https://synthetic.invalid",
        "synthetic-token",
        "authorization-first",
        false,
    );
    assert!(first.valid(), "metadata/no-op retains capture");
    services.publish(
        &scope,
        "https://synthetic.invalid",
        "synthetic-token-2",
        "authorization-second",
        false,
    );
    assert!(!first.valid(), "same lease cannot hide auth replacement");
    let next = reader.capture_download(&scope, &window).unwrap();
    services.set_runtime_suspended(true);
    assert!(!next.valid());
    assert!(reader.capture_download(&scope, &window).is_err());
    services.set_runtime_suspended(false);
    assert!(!next.valid(), "wake does not revive an old readhandle");
    let next = reader.capture_download(&scope, &window).unwrap();
    services.shutdown();
    assert!(!next.valid());
    assert!(reader.capture_download(&scope, &window).is_err());
}

#[test]
fn production_download_install_uses_committed_reader_native_jobs_and_same_authenticated_network() {
    struct RawNetwork(Arc<AtomicUsize>);
    impl Network for RawNetwork {
        fn fetch(
            &self,
            request: HttpRequest,
            mut events: nsh_engine::FetchEvents,
        ) -> Box<dyn FetchTask> {
            assert_eq!(request.method, "GET");
            assert_eq!(
                request.url,
                "https://host.invalid/api/fs/raw?path=%2Fsynthetic%2Ffile.bin&directory=%2Fsynthetic&download=true"
            );
            assert!(!request.follow_redirects);
            assert!(
                request
                    .headers
                    .contains(&("Authorization".into(), "Bearer synthetic-test-token".into()))
            );
            self.0.fetch_add(1, Ordering::Relaxed);
            events(FetchEvent::Head(HttpHead {
                status: 200,
                url: request.url,
                headers: vec![
                    ("Content-Length".into(), "4".into()),
                    ("ETag".into(), "\"synthetic\"".into()),
                ],
                ..Default::default()
            }));
            events(FetchEvent::Data(vec![0, 255, 13, 10]));
            events(FetchEvent::End);
            Box::new(FakeTask(Arc::new(AtomicUsize::new(0))))
        }
    }
    struct Bytes(Vec<u8>);
    impl transport::Consumer for Bytes {
        fn begin(&mut self, _: &transport::Checkpoint) -> Result<()> {
            Ok(())
        }
        fn append(&mut self, b: &[u8]) -> Result<()> {
            self.0.extend_from_slice(b);
            Ok(())
        }
        fn progress(&mut self, _: &transport::Checkpoint) {}
    }
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let count = Arc::new(AtomicUsize::new(0));
    let network = Arc::new(RawNetwork(count.clone()));
    let mut caps = file_download::METHODS.to_vec();
    caps.extend([
        "connection.list",
        "connection.editor",
        "connection.rename",
        "connection.select",
    ]);
    let owner = install_with(
        &host,
        &json!({"host":caps}),
        Box::new(vault),
        network.clone(),
        false,
    )
    .unwrap();
    let services = owner.services();
    let (port, inbox) = file_download::channel();
    services.install_file_download(&host, port).unwrap();
    let window = services.window_id().unwrap();
    let reader = services.reader();
    let n = network.clone();
    host.handle("test.downloadRead", move |mut call| {
        let input = call.take_data();
        let reader = reader.clone();
        let network = n.clone();
        let window = window.clone();
        let reply = call.into_reply().unwrap();
        std::thread::spawn(move || {
            let result = (|| {
                let capture = reader.capture_download(&input, &window)?;
                let mut checkpoint = transport::Checkpoint::default();
                let mut bytes = Bytes(Vec::new());
                transport::receive(
                    network,
                    &capture,
                    &transport::HostFile {
                        directory: "/synthetic".into(),
                        path: "/synthetic/file.bin".into(),
                    },
                    &mut checkpoint,
                    || true,
                    &mut bytes,
                )?;
                Ok(json!({"bytes":bytes.0,"received":checkpoint.received}))
            })();
            reply.reply(result);
        });
    });
    let suspended = services.clone();
    host.handle("test.suspend", move |mut call| {
        suspended.set_runtime_suspended(call.take_data()["suspended"].as_bool().unwrap());
        call.resolve(json!(true));
    });
    let stopped = services.clone();
    host.handle("test.shutdown", move |call| {
        stopped.shutdown();
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let engine=engine(host,r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};const saved=await host.call('connection.list',{});const expectedHost=saved.runtimeScope;
      const capability=await host.call('desktop.files.download.capabilities',{});check(capability.version===2&&capability.save&&capability.windowID,'real installed v2');
      const input={ownerID:'synthetic-owner',requestID:'synthetic-request',windowID:capability.windowID,expectedHost};const selecting=await host.call('desktop.files.download.save',{...input,directory:'/synthetic',path:'/synthetic/file.bin'});check(selecting.state==='selecting','native job queued, not fake save');
      const editor=await host.call('connection.editor',{id:saved.selected});await host.call('connection.rename',{id:saved.selected,version:editor.version,label:'Metadata'});check((await host.call('desktop.files.download.status',input)).state==='selecting','metadata preserves pending grant');
      const read=await host.call('test.downloadRead',expectedHost);check(JSON.stringify(read.bytes)==='[0,255,13,10]'&&read.received===4,'same actor captured authenticated raw GET');
      await host.call('test.suspend',{suspended:true});let blocked=false;try{await host.call('desktop.files.download.status',input);}catch{blocked=true;}check(blocked,'suspension rejects capture');await host.call('test.suspend',{suspended:false});check((await host.call('desktop.files.download.status',input)).state==='cancelled','suspension synchronously invalidates pending native job');
      await host.call('connection.select',{id:saved.selected});let stale=false;try{await host.call('desktop.files.download.status',input);}catch{stale=true;}check(stale,'old lease cannot access new generation');
      await host.call('test.shutdown',{});let closed=false;try{await host.call('desktop.files.download.capabilities',{});}catch{closed=true;}check(closed,'owner dropped before view teardown');host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    assert_eq!(count.load(Ordering::Relaxed), 1);
    assert!(
        inbox.try_recv().is_some(),
        "real native job retained; no OS chooser run"
    );
    drop(engine);
    drop(owner);
}
