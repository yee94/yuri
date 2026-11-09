//! Real actor/HostChannel/QuickJS receipt cancellation; only synthetic Network callbacks.
use super::*;
#[derive(Default)]
struct HeldNetwork {
    callbacks: Mutex<HashMap<String, nsh_engine::FetchEvents>>,
    requests: Mutex<Vec<String>>,
    cancelled: Arc<Mutex<Vec<String>>>,
}
struct HeldTask(String, Arc<Mutex<Vec<String>>>);
impl FetchTask for HeldTask {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {
        self.1.lock().unwrap().push(self.0.clone());
    }
}
impl Network for HeldNetwork {
    fn fetch(&self, request: HttpRequest, events: nsh_engine::FetchEvents) -> Box<dyn FetchTask> {
        assert!(!request.follow_redirects);
        assert!(
            request
                .headers
                .contains(&("Authorization".into(), "Bearer synthetic-test-token".into()))
        );
        let url = request.url.clone();
        self.requests.lock().unwrap().push(url.clone());
        self.callbacks.lock().unwrap().insert(url.clone(), events);
        Box::new(HeldTask(url, self.cancelled.clone()))
    }
}
#[test]
fn receipt_cancel_before_start_late_end_and_old_lease_do_not_touch_other_owners() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let network = Arc::new(HeldNetwork::default());
    let owner=install_with(&host,&json!({"host":["connection.list","connection.select","runtime.request","runtime.stream","runtime.stop","runtime.http.capabilities","runtime.http.request","runtime.http.cancel"]}),Box::new(vault),network.clone(),false).unwrap();
    let emitting = network.clone();
    host.handle("test.emitHttp", move |mut call| {
        let input = call.take_data();
        let url = format!("https://host.invalid{}", input["path"].as_str().unwrap());
        let mut callbacks = emitting.callbacks.lock().unwrap();
        let callback = callbacks.get_mut(&url).unwrap();
        callback(FetchEvent::Head(HttpHead {
            status: 200,
            url,
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }));
        callback(FetchEvent::Data(
            br#"{"data":{"text":"synthetic-result"}}"#.to_vec(),
        ));
        callback(FetchEvent::End);
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine=engine(host,r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};const reject=async(name,input)=>{try{await host.call(name,input);return false;}catch{return true;}};
      const capability=await host.call('runtime.http.capabilities',{});check(capability.version===1&&capability.request&&capability.cancel&&capability.maxConcurrent===8&&capability.timeoutMs===30000,'native receipt support');
      const saved=await host.call('connection.list',{});const expectedHost=saved.runtimeScope;const identity={ownerID:'synthetic-btw',requestID:'generate-1',windowID:capability.windowID,expectedHost};const request={...identity,path:'/api/session/synthetic/generate',method:'POST',body:{prompt:'synthetic'}};
      await host.call('runtime.http.cancel',{...identity,requestID:'never-started'});check(await reject('runtime.http.request',{...request,requestID:'never-started'}),'pre-cancel prevents fetch');
      await host.call('runtime.stream',{key:'global',path:'/api/yuri/events',expectedHost});
      const ordinary=host.call('runtime.request',{path:'/api/ordinary',expectedHost});const pending=host.call('runtime.http.request',request).then(()=>({bad:true}),error=>({error:String(error)}));await host.call('connection.list',{});
      check(await reject('runtime.http.cancel',{...identity,ownerID:'wrong-owner'}),'wrong owner cannot cancel');check(await reject('runtime.http.cancel',{...identity,windowID:'wrong-window'}),'wrong window cannot cancel');
      await host.call('runtime.http.cancel',identity);check((await pending).error.includes('http_request_cancelled'),'original request settled once');
      await host.call('test.emitHttp',{path:request.path});await host.call('test.emitHttp',{path:'/api/ordinary'});check((await ordinary).body.data.text==='synthetic-result','ordinary main HTTP untouched');
      check(await reject('runtime.http.request',request),'request ID cannot be replayed');
      const next=await host.call('connection.select',{id:saved.selected});const newer={...request,requestID:'generate-2',expectedHost:next.runtimeScope};const current=host.call('runtime.http.request',newer);await host.call('connection.list',{});
      check(await reject('runtime.http.cancel',identity),'old lease cannot cancel new job');await host.call('test.emitHttp',{path:request.path});check((await current).body.data.text==='synthetic-result','new lease completes');host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    let requests = network.requests.lock().unwrap();
    assert_eq!(requests.len(), 4, "pre-cancel/replay send no HTTP");
    drop(requests);
    let cancelled = network.cancelled.lock().unwrap();
    assert_eq!(cancelled.len(), 2);
    assert!(cancelled.iter().any(|u| u.ends_with("/generate")));
    assert!(
        cancelled.iter().any(|u| u.ends_with("/api/yuri/events")),
        "scope retirement, not HTTP cancel, retires SSE"
    );
    drop(cancelled);
    drop(owner);
}
#[test]
fn receipt_jobs_share_the_eight_job_budget_and_timeout_retains_non_reusable_ids() {
    let (mut actor, _, network) = actor();
    let window = actor.services.window_id().unwrap();
    let scope = actor.state().scope.clone().unwrap();
    let input = |id: usize| json!({"ownerID":"synthetic","requestID":format!("request-{id}"),"windowID":window,"expectedHost":scope,"path":"/api/read"});
    for id in 0..MAX_HTTP {
        actor.http_request(input(id), HostReply::default());
    }
    actor.http_request(input(8), HostReply::default());
    assert_eq!(actor.jobs.len(), MAX_HTTP);
    assert_eq!(network.requests.lock().unwrap().len(), MAX_HTTP);
    let key = http_receipts::Key::parse(&input(8), &window, true).unwrap();
    assert!(
        actor.http_receipts.reserve(&key).is_err(),
        "a rejected admission cannot reuse its reserved ID"
    );
    for job in actor.jobs.values_mut() {
        job.deadline = Instant::now() - Duration::from_secs(1);
    }
    actor.tick();
    assert!(actor.jobs.is_empty());
    assert_eq!(network.cancelled.load(Ordering::Relaxed), MAX_HTTP);
    actor.http_request(input(0), HostReply::default());
    assert!(actor.jobs.is_empty());
    assert_eq!(network.requests.lock().unwrap().len(), MAX_HTTP);
}
#[test]
fn receipt_capability_never_loads_vault_and_shutdown_is_not_available() {
    struct NoVault;
    impl Vault for NoVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            panic!("metadata cannot read credentials")
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            panic!("metadata cannot write credentials")
        }
    }
    let host = HostChannel::default();
    let owner = install_with(
        &host,
        &json!({"host":["runtime.http.capabilities"]}),
        Box::new(NoVault),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    let services = owner.services();
    host.handle("test.close", move |call| {
        services.shutdown();
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine=engine(host,r#"import {host} from 'nsh';(async()=>{const cap=await host.call('runtime.http.capabilities',{});await host.call('test.close',{});let closed=false;try{await host.call('runtime.http.capabilities',{});}catch{closed=true;}host.post('test.result',{ok:cap.version===1&&closed});})().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ok":true})
    );
}

#[test]
fn receipt_http_queue_full_rejects_request_and_cancel_before_dispatch() {
    struct PausedVault {
        store: MemoryVault,
        entered: mpsc::SyncSender<()>,
        resume: Mutex<mpsc::Receiver<()>>,
    }
    impl Vault for PausedVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            self.entered.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
            self.store.read()
        }
        fn write(&self, bytes: &[u8]) -> Result<()> {
            self.store.write(bytes)
        }
    }
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let (entered, waiting) = mpsc::sync_channel(1);
    let (resume, paused) = mpsc::sync_channel(1);
    let host = HostChannel::default();
    let network = Arc::new(FakeNetwork::default());
    let owner = install_with(
        &host,
        &json!({"host":["runtime.http.request","runtime.http.cancel"]}),
        Box::new(PausedVault {
            store,
            entered,
            resume: Mutex::new(paused),
        }),
        network.clone(),
        false,
    )
    .unwrap();
    owner
        .tx
        .try_send(Message::Call(
            "connection.list".into(),
            json!({}),
            HostReply::default(),
        ))
        .ok()
        .unwrap();
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    for _ in 0..QUEUE {
        owner
            .tx
            .try_send(Message::RefreshNotifications)
            .ok()
            .unwrap();
    }
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(
        host,
        r#"import {host} from 'nsh';(async()=>{
      const errors=[];
      for(const name of ['runtime.http.request','runtime.http.cancel']) {
        try { await host.call(name,{}); errors.push('unexpected-success'); }
        catch(error) { errors.push(String(error)); }
      }
      host.post('test.result',{errors});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#
            .into(),
    );
    let result = rx.recv_timeout(Duration::from_secs(5));
    resume.send(()).unwrap();
    let result = result.unwrap();
    assert_eq!(result["errors"].as_array().unwrap().len(), 2);
    for error in result["errors"].as_array().unwrap() {
        assert!(error.as_str().unwrap().contains("native_host_busy"));
    }
    assert!(network.requests.lock().unwrap().is_empty());
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 0);
}

#[test]
fn receipt_scope_retire_and_bad_responses_settle_once_without_replay() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let network = Arc::new(HeldNetwork::default());
    let _owner = install_with(&host, &json!({"host":["connection.list","connection.select","runtime.http.capabilities","runtime.http.request","runtime.http.cancel"]}), Box::new(vault), network.clone(), false).unwrap();
    let emitting = network.clone();
    host.handle("test.response", move |mut call| {
        let input = call.take_data();
        let url = format!("https://host.invalid{}", input["path"].as_str().unwrap());
        let mut callbacks = emitting.callbacks.lock().unwrap();
        let callback = callbacks.get_mut(&url).unwrap();
        let (status, bytes) = match input["kind"].as_str().unwrap() {
            "redirect" => (302, b"{}".to_vec()),
            "invalid-json" => (200, b"not-json".to_vec()),
            "server-error" => (409, br#"{"error":"synthetic-conflict"}"#.to_vec()),
            _ => (200, b"{}".to_vec()),
        };
        callback(FetchEvent::Head(HttpHead {
            status,
            url,
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }));
        callback(FetchEvent::Data(bytes));
        callback(FetchEvent::End);
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(host, r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};
      const cap=await host.call('runtime.http.capabilities',{});let saved=await host.call('connection.list',{});
      const identity={ownerID:'receipt-failures',windowID:cap.windowID,expectedHost:saved.runtimeScope};
      let settled=0;const retired={...identity,requestID:'retired',path:'/api/retired'};
      const pending=host.call('runtime.http.request',retired).then(()=>{settled++;return 'unexpected-success';},error=>{settled++;return String(error);});
      saved=await host.call('connection.select',{id:saved.selected});
      check((await pending).includes('runtime_host_scope_stale'),'retire rejects original reply');
      await host.call('test.response',{path:retired.path,kind:'late'});
      let reused=false;try{await host.call('runtime.http.request',{...retired,expectedHost:saved.runtimeScope});}catch{reused=true;}check(reused,'scope retire retains ID');
      for(const [requestID,expected] of [['redirect','host_redirect_or_invalid_response'],['invalid-json','invalid_json_response']]) {
        const request={...identity,expectedHost:saved.runtimeScope,requestID,path:'/api/'+requestID};
        const failed=host.call('runtime.http.request',request).then(()=>{settled++;return 'unexpected-success';},error=>{settled++;return String(error);});
        await host.call('connection.list',{});await host.call('test.response',{path:request.path,kind:requestID});
        check((await failed).includes(expected),'stable failure '+requestID);
        await host.call('test.response',{path:request.path,kind:'late'});
        let replayed=false;try{await host.call('runtime.http.request',request);replayed=true;}catch{}check(!replayed,'failure ID is terminal');
      }
      const request={...identity,expectedHost:saved.runtimeScope,requestID:'server-error',path:'/api/server-error'};
      const conflict=host.call('runtime.http.request',request);await host.call('connection.list',{});await host.call('test.response',{path:request.path,kind:'server-error'});
      const response=await conflict;check(response.status===409&&response.body.error==='synthetic-conflict','ordinary HTTP status/body preserved');
      check(settled===3,'late events never settle again');host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    assert_eq!(network.requests.lock().unwrap().len(), 4);
    assert_eq!(network.cancelled.lock().unwrap().len(), 3);
}
