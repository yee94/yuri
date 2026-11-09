//! Production actor/HostChannel/QuickJS with synthetic Network; no Host, UI or PTY.
use super::*;

#[test]
fn panel_capacity_replacement_and_stop_leave_global_and_chat_untouched() {
    let (mut actor, _, network) = actor();
    let scope = actor.state().scope.clone().unwrap();
    for (key, path) in [
        ("global", "/api/yuri/events"),
        ("chat", "/api/event?directory=%2Fmain"),
    ] {
        actor
            .immediate(
                "runtime.stream",
                &json!({"key":key,"path":path,"expectedHost":scope}),
            )
            .unwrap();
    }
    for n in 1..=runtime_stream::MAX_PANEL_STREAMS {
        actor.immediate("runtime.stream",&json!({"key":format!("panel-chat:{n}:1"),"path":"/api/event?directory=%2Fpanel","expectedHost":scope})).unwrap();
    }
    let count = network.requests.lock().unwrap().len();
    assert_eq!(count, 2 + runtime_stream::MAX_PANEL_STREAMS);
    let input =
        json!({"key":"panel-chat:1:1","path":"/api/event?directory=%2Fpanel","expectedHost":scope});
    for _ in 0..50 {
        actor.immediate("runtime.stream", &input).unwrap();
    }
    assert_eq!(
        network.requests.lock().unwrap().len(),
        count,
        "same activation never restarts transport"
    );
    assert_eq!(actor.immediate("runtime.stream",&json!({"key":"panel-chat:5:1","path":"/api/event?directory=%2Fpanel","expectedHost":scope})).unwrap_err(),"runtime_stream_capacity");
    assert_eq!(actor.immediate("runtime.stream",&json!({"key":"panel-chat:1:1","path":"/api/event?directory=%2Fother","expectedHost":scope})).unwrap_err(),"runtime_stream_target_mismatch");
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 0);
    actor
        .immediate(
            "runtime.stop",
            &json!({"key":"panel-chat:1:1","expectedHost":scope}),
        )
        .unwrap();
    actor.immediate("runtime.stream",&json!({"key":"panel-chat:5:1","path":"/api/event?directory=%2Fpanel","expectedHost":scope})).unwrap();
    assert!(actor.streams.contains_key("global") && actor.streams.contains_key("chat"));
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 1);
    actor.invalidate();
    assert!(actor.streams.is_empty());
    assert_eq!(network.cancelled.load(Ordering::Relaxed), count + 1);
}

#[test]
fn panel_invalid_start_and_stale_stop_never_touch_existing_streams() {
    let (mut actor, _, network) = actor();
    let old = actor.state().scope.clone().unwrap();
    let input =
        json!({"key":"panel-chat:1:1","path":"/api/event?directory=%2Fpanel","expectedHost":old});
    actor.immediate("runtime.stream", &input).unwrap();
    actor
        .immediate("connection.select", &json!({"id":"synthetic-host"}))
        .unwrap();
    let current = actor.state().scope.clone().unwrap();
    let mut fresh = input.clone();
    fresh["expectedHost"] = current.clone();
    actor.immediate("runtime.stream", &fresh).unwrap();
    assert!(actor.immediate("runtime.stream", &input).is_err());
    assert!(
        actor
            .immediate(
                "runtime.stop",
                &json!({"key":"panel-chat:1:1","expectedHost":old})
            )
            .is_err()
    );
    for key in [
        "panel-chat:1",
        "panel-chat:0:1",
        "panel-chat:1:9007199254740992",
        "terminal:1:1",
    ] {
        assert!(
            actor
                .immediate("runtime.stop", &json!({"key":key,"expectedHost":current}))
                .is_err()
        );
    }
    for path in [
        "/api/yuri/events",
        "/api/event?directory=%2Fp&directory=%2Fother",
        "/api/event?directory=%FF",
    ] {
        let mut bad = fresh.clone();
        bad["path"] = json!(path);
        assert!(actor.immediate("runtime.stream", &bad).is_err());
    }
    for expected in [
        Value::Null,
        json!({"hostID":"wrong","lease":current["lease"]}),
        json!({"hostID":current["hostID"],"lease":"bad"}),
    ] {
        let mut bad = fresh.clone();
        bad["expectedHost"] = expected.clone();
        assert!(actor.immediate("runtime.stream", &bad).is_err());
        assert!(
            actor
                .immediate(
                    "runtime.stop",
                    &json!({"key":"panel-chat:1:1","expectedHost":expected})
                )
                .is_err()
        );
    }
    assert_eq!(network.requests.lock().unwrap().len(), 2);
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 1);
    assert_eq!(actor.streams.len(), 1);
    let ticket = actor.streams["panel-chat:1:1"].ticket;
    actor
        .immediate(
            "runtime.stop",
            &json!({"key":"panel-chat:1:1","expectedHost":current}),
        )
        .unwrap();
    actor.event(ticket, FetchEvent::Data(b"data: late\n\n".to_vec()));
    assert!(actor.streams.is_empty());
}

#[test]
fn native_stream_capabilities_are_exact_read_only_metadata_without_vault_access() {
    struct NoVault;
    impl Vault for NoVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            panic!("capabilities must not load credentials")
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            panic!("capabilities must not write credentials")
        }
    }
    let host = HostChannel::default();
    let _owner = install_with(
        &host,
        &json!({"host":["runtime.stream.capabilities"]}),
        Box::new(NoVault),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(
        host,
        r#"import {host} from 'nsh';(async()=>{
      const capability=await host.call('runtime.stream.capabilities',{});let rejected=false;
      try{await host.call('runtime.stream.capabilities',{supported:true});}catch{rejected=true;}
      host.post('test.result',{capability,rejected});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#
            .into(),
    );
    let mut expected = runtime_stream::capabilities();
    // QuickJS returns large JS-safe integers as f64; verify the exact numeric
    // value without mistaking serde_json's integer/float storage for a wire gap.
    expected["panelChat"]["maxID"] = json!(9_007_199_254_740_991f64);
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"capability":expected,"rejected":true})
    );
}

#[test]
fn production_panel_events_keep_key_and_lease_and_cleanup_never_stops_main_or_global() {
    #[derive(Default)]
    struct LiveNetwork {
        callbacks: Mutex<HashMap<String, nsh_engine::FetchEvents>>,
        cancelled: Arc<Mutex<Vec<String>>>,
    }
    struct Task(String, Arc<Mutex<Vec<String>>>);
    impl FetchTask for Task {
        fn send(&mut self, _: Vec<u8>) {}
        fn finish(&mut self) {}
        fn pause(&mut self, _: bool) {}
        fn cancel(self: Box<Self>) {
            self.1.lock().unwrap().push(self.0.clone());
        }
    }
    impl Network for LiveNetwork {
        fn fetch(
            &self,
            request: HttpRequest,
            mut events: nsh_engine::FetchEvents,
        ) -> Box<dyn FetchTask> {
            assert_eq!(request.method, "GET");
            assert!(!request.follow_redirects);
            assert!(
                request
                    .headers
                    .contains(&("Authorization".into(), "Bearer synthetic-test-token".into()))
            );
            events(FetchEvent::Head(HttpHead {
                status: 200,
                url: request.url.clone(),
                headers: vec![("Content-Type".into(), "text/event-stream".into())],
                ..Default::default()
            }));
            self.callbacks
                .lock()
                .unwrap()
                .insert(request.url.clone(), events);
            Box::new(Task(request.url, self.cancelled.clone()))
        }
    }
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let network = Arc::new(LiveNetwork::default());
    let _owner=install_with(&host,&json!({"host":["connection.list","connection.select","runtime.stream","runtime.stop","runtime.stream.capabilities"]}),Box::new(vault),network.clone(),false).unwrap();
    let emitting = network.clone();
    host.handle("test.emit", move |mut call| {
        let input = call.take_data();
        let path = input["path"].as_str().unwrap();
        let url = format!("https://host.invalid{path}");
        let event = if input["disconnect"] == true {
            FetchEvent::Failed("synthetic".into())
        } else {
            FetchEvent::Data(format!("data: {}\n\n", input["data"]).into_bytes())
        };
        emitting.callbacks.lock().unwrap().get_mut(&url).unwrap()(event);
        call.resolve(json!(true));
    });
    let observed = network.clone();
    host.handle("test.cancelled", move |call| {
        call.resolve(json!(*observed.cancelled.lock().unwrap()));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine=engine(host,r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};const saved=await host.call('connection.list',{});const expectedHost=saved.runtimeScope;
      const events=[],disconnected=[];host.on('runtime.event',v=>events.push(v));host.on('runtime.disconnected',v=>disconnected.push(v));
      const paths={global:'/api/yuri/events',chat:'/api/event?directory=%2Fmain','panel-chat:7:1':'/api/event?directory=%2Fpanel'};
      for(const [key,path] of Object.entries(paths))await host.call('runtime.stream',{key,path,expectedHost});
      await host.call('test.emit',{path:paths['panel-chat:7:1'],data:{type:'message.part.updated',marker:'panel'}});await host.call('connection.list',{});
      check(events.some(v=>v.key==='panel-chat:7:1'&&v.expectedHost.lease===expectedHost.lease&&v.data&&JSON.parse(v.data).marker==='panel'),'panel payload exact native key/scope');
      await host.call('test.emit',{path:paths['panel-chat:7:1'],disconnect:true});await host.call('connection.list',{});
      check(disconnected.some(v=>v.key==='panel-chat:7:1'&&v.expectedHost.lease===expectedHost.lease),'panel disconnect exact key');
      await host.call('runtime.stop',{key:'panel-chat:7:1',expectedHost});
      const before=events.length;await host.call('test.emit',{path:paths['panel-chat:7:1'],data:{marker:'late'}});
      await host.call('test.emit',{path:paths.chat,data:{marker:'main-still-live'}});await host.call('test.emit',{path:paths.global,data:{marker:'global-still-live'}});await host.call('connection.list',{});
      check(events.slice(before).filter(v=>v.data).length===2,'late panel discarded');
      check(events.some(v=>v.key==='chat'&&v.data&&JSON.parse(v.data).marker==='main-still-live'),'main untouched');
      check(events.some(v=>v.key==='global'&&v.data&&JSON.parse(v.data).marker==='global-still-live'),'global untouched');
      check((await host.call('test.cancelled',{})).every(path=>path.endsWith('directory=%2Fpanel')),'no unrelated cancellation');
      await host.call('connection.select',{id:saved.selected});check((await host.call('test.cancelled',{})).length===3,'scope retire clears all streams');
      host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
}
