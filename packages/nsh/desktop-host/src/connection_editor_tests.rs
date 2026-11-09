//! Production actor/QuickJS editor contracts; all credentials and storage are synthetic.
use super::*;

fn edit(label: &str) -> Value {
    json!({"id":"synthetic-host","version":"legacy","label":label})
}
fn candidate() -> Connection {
    let mut candidate = connection();
    candidate.id.clear();
    candidate.url = "https://replacement.invalid".into();
    candidate.token = "synthetic-fresh-token".into();
    candidate.label = "Replacement".into();
    candidate.used = 999.;
    candidate
}
fn complete_probe(actor: &mut Actor, status: u16, body: Value) {
    let (&ticket, job) = actor
        .jobs
        .iter()
        .find(|(_, job)| matches!(job.completion, Completion::Connect { .. }))
        .unwrap();
    let url = job.url.clone();
    actor.event(
        ticket,
        FetchEvent::Head(HttpHead {
            status,
            url,
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }),
    );
    actor.event(ticket, FetchEvent::Data(body.to_string().into_bytes()));
    actor.event(ticket, FetchEvent::End);
}
#[test]
fn editor_descriptor_is_metadata_only_and_legacy_noop_never_writes() {
    let (mut actor, store, network) = actor();
    let before = store.read().unwrap();
    let descriptor = actor
        .immediate("connection.editor", &json!({"id":"synthetic-host"}))
        .unwrap();
    assert_eq!(
        descriptor,
        json!({"id":"synthetic-host","version":"legacy","label":"Synthetic","url":"https://host.invalid","transport":"direct","lastUsedAt":1.})
    );
    assert!(!descriptor.to_string().contains("authorization"));
    assert!(!descriptor.to_string().contains("token"));
    store.fail.store(true, Ordering::Release);
    let scope = actor.state().scope.clone();
    let browser = actor.browser.capture(scope.as_ref().unwrap()).unwrap();
    actor.immediate("connection.edit",&json!({"id":"synthetic-host","version":"legacy","label":"  Synthetic  ","url":"HTTPS://HOST.invalid:443/"})).unwrap();
    assert_eq!(store.read().unwrap(), before);
    assert_eq!(actor.state().scope, scope);
    assert!(browser.current());
    assert!(network.requests.lock().unwrap().is_empty());
}
#[test]
fn metadata_cas_preserves_credentials_selection_recency_and_all_runtime_owners() {
    let (mut actor, store, network) = actor();
    let original = actor.state().current().unwrap();
    let scope = actor.state().scope.clone().unwrap();
    let browser = actor.browser.capture(&scope).unwrap();
    actor
        .immediate(
            "runtime.stream",
            &json!({"key":"global","path":"/api/yuri/events","expectedHost":scope}),
        )
        .unwrap();
    actor.request(
        json!({"path":"/api/config/settings","expectedHost":scope}),
        HostReply::default(),
    );
    let snapshot = actor
        .immediate("connection.rename", &edit("  Renamed 中文  "))
        .unwrap();
    let current = actor.state().current().unwrap();
    assert_eq!(current.id, original.id);
    assert_eq!(current.token, original.token);
    assert_eq!(current.authorization, original.authorization);
    assert_eq!(current.url, original.url);
    assert_eq!(current.used, original.used);
    assert_eq!(snapshot["runtimeScope"], scope);
    assert_eq!(actor.jobs.len(), 1);
    assert_eq!(actor.streams.len(), 1);
    assert!(browser.current());
    assert!(actor.services.reader().current(&scope));
    assert_eq!(network.cancelled.load(Ordering::Acquire), 0);
    let version = current.editor_version.clone().unwrap();
    assert_ne!(version, "legacy");
    let restored = State::load(&store, false).unwrap();
    assert_eq!(restored.current().unwrap().editor_version, Some(version));
    assert_eq!(restored.current().unwrap().label, "Renamed 中文");
    assert_eq!(
        actor
            .immediate("connection.rename", &edit("Old form"))
            .unwrap_err(),
        editor::STALE
    );
    let mut next = actor.state().clone();
    let mut history = connection();
    history.id = "history".into();
    history.url = "https://history.invalid".into();
    history.token = "synthetic-history-token".into();
    next.connections.push(history);
    actor.commit(next, false).unwrap();
    actor
        .immediate(
            "connection.rename",
            &json!({"id":"history","version":"legacy","label":"History renamed"}),
        )
        .unwrap();
    assert_eq!(actor.state().selected.as_deref(), Some("synthetic-host"));
    assert_eq!(actor.state().scope, Some(scope));
    assert!(browser.current());
}
#[test]
fn editor_invalid_stale_cross_origin_and_sensitive_fields_fail_without_network_or_mutation() {
    let (mut actor, store, network) = actor();
    let before = store.read().unwrap();
    for label in [
        "".into(),
        "   ".into(),
        "a\nb".into(),
        "x".repeat(121),
        "😀".repeat(61),
    ] {
        assert_eq!(
            actor
                .immediate("connection.rename", &edit(&label))
                .unwrap_err(),
            editor::INVALID
        );
    }
    for url in [
        "ssh://host.invalid",
        "https://user:password@host.invalid",
        "https://host.invalid/path",
        "https://host.invalid/?token=synthetic",
        "https://host.invalid/#fragment",
        "https://host.invalid/%2f",
        "https://host.invalid:0",
    ] {
        let mut input = edit("Renamed");
        input["url"] = json!(url);
        assert_eq!(
            actor.immediate("connection.edit", &input).unwrap_err(),
            editor::INVALID,
            "{url}"
        );
    }
    for url in [
        "https://replacement.invalid",
        "http://host.invalid",
        "https://host.invalid:444",
    ] {
        let mut input = edit("Renamed");
        input["url"] = json!(url);
        assert_eq!(
            actor.immediate("connection.edit", &input).unwrap_err(),
            editor::PAIRING
        );
    }
    for key in ["token", "password", "relay", "headers", "authorizationID"] {
        let mut input = edit("Renamed");
        input[key] = json!("forbidden");
        assert_eq!(
            actor.immediate("connection.edit", &input).unwrap_err(),
            editor::INVALID
        );
    }
    let mut input = edit("Renamed");
    input["url"] = json!("https://host.invalid");
    assert_eq!(
        actor.immediate("connection.rename", &input).unwrap_err(),
        editor::INVALID
    );
    input = edit("Renamed");
    input["version"] = json!("wrong");
    assert_eq!(
        actor.immediate("connection.edit", &input).unwrap_err(),
        editor::STALE
    );
    assert_eq!(
        actor
            .immediate("connection.editor", &json!({"id":"missing"}))
            .unwrap_err(),
        editor::MISSING
    );
    assert_eq!(
        actor
            .immediate(
                "connection.editor",
                &json!({"id":"synthetic-host","token":"forbidden"})
            )
            .unwrap_err(),
        editor::INVALID
    );
    assert_eq!(store.read().unwrap(), before);
    assert!(network.requests.lock().unwrap().is_empty());
    assert!(
        policy::origin("http://host.invalid", true).is_err(),
        "editor's syntax-only HTTP comparison cannot authorize network I/O"
    );
}
#[test]
fn editor_failed_write_preserves_prior_and_cross_process_unknown_or_conflict_quarantines() {
    let (mut actor, store, _) = actor();
    let before = store.read().unwrap();
    let snapshot = actor.state().snapshot();
    let capture = actor
        .browser
        .capture(actor.state().scope.as_ref().unwrap())
        .unwrap();
    store.fail.store(true, Ordering::Release);
    assert_eq!(
        actor
            .immediate("connection.rename", &edit("Uncommitted"))
            .unwrap_err(),
        "connection_editor_storage"
    );
    assert_eq!(actor.state().snapshot(), snapshot);
    assert_eq!(store.read().unwrap(), before);
    assert!(capture.current());
    struct Uncertain(&'static str);
    impl Vault for Uncertain {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            panic!("already loaded")
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            Err(self.0.into())
        }
    }
    for error in [vault::COMMIT_UNKNOWN, vault::CONFLICT] {
        let (mut actor, _, _) = super::actor();
        let scope = actor.state().scope.clone().unwrap();
        let reader = actor.services.reader();
        actor.vault = Box::new(Uncertain(error));
        assert_eq!(
            actor
                .immediate("connection.edit", &edit("Uncertain"))
                .unwrap_err(),
            error
        );
        assert!(actor.quarantined);
        assert!(actor.state.is_none());
        assert!(!reader.current(&scope));
    }
}
#[test]
fn reauthorization_requires_explicit_fresh_credentials_and_rechecks_cas_and_duplicate_identity() {
    let (mut actor, store, network) = actor();
    let before = store.read().unwrap();
    for input in [
        json!({"id":"synthetic-host"}),
        json!({"version":"legacy"}),
        json!({"id":"synthetic-host","version":"legacy"}),
        json!({"id":"synthetic-host","version":"legacy","token":"synthetic-test-token"}),
    ] {
        assert!(editor::replacement(actor.state(), &input).is_err());
        actor.connect(input, HostReply::default());
    }
    assert!(network.requests.lock().unwrap().is_empty());
    assert_eq!(store.read().unwrap(), before);
    let target = editor::replacement(
        actor.state(),
        &json!({"id":"synthetic-host","version":"legacy","token":"synthetic-fresh-token"}),
    )
    .unwrap()
    .unwrap();
    let mut state = actor.state().clone();
    let mut other = connection();
    other.id = "other".into();
    other.url = candidate().url;
    other.token = "synthetic-other-token".into();
    state.connections.push(other);
    assert_eq!(
        editor::replacing(&state, &target, candidate())
            .err()
            .unwrap(),
        editor::DUPLICATE
    );
    assert!(
        editor::replacement(
            &state,
            &json!({"id":"synthetic-host","version":"legacy","token":"synthetic-other-token"})
        )
        .is_err()
    );
    actor
        .immediate("connection.rename", &edit("Changed while authorizing"))
        .unwrap();
    assert_eq!(
        editor::replacing(actor.state(), &target, candidate())
            .err()
            .unwrap(),
        editor::STALE
    );
}
#[test]
fn selected_and_history_reauthorization_keep_original_id_and_only_retire_selected_scope() {
    for selected in [true, false] {
        let (mut actor, store, _) = actor();
        let mut state = actor.state().clone();
        if !selected {
            let mut other = connection();
            other.id = "other".into();
            other.url = "https://other.invalid".into();
            state.connections.push(other);
            state.selected = Some("other".into());
            state.rotate().unwrap();
            actor.state = Some(state);
            actor.authorize_services();
        }
        let original = editor::record(actor.state(), "synthetic-host", None)
            .unwrap()
            .clone();
        let old_scope = actor.state().scope.clone().unwrap();
        let old_browser = actor.browser.capture(&old_scope).unwrap();
        actor.connect(json!({"id":"synthetic-host","version":"legacy","url":"https://replacement.invalid","label":"New name","token":"synthetic-fresh-token"}),HostReply::default());
        complete_probe(&mut actor, 200, json!({"ok":true}));
        let replacement = editor::record(actor.state(), "synthetic-host", None).unwrap();
        assert_eq!(replacement.id, original.id);
        assert_eq!(replacement.used, original.used);
        assert_eq!(replacement.label, "New name");
        assert_ne!(replacement.authorization, original.authorization);
        assert!(replacement.editor_version.is_some());
        assert_eq!(replacement.token, "synthetic-fresh-token");
        assert_eq!(
            actor.state().connections.len(),
            if selected { 1 } else { 2 }
        );
        assert_eq!(old_browser.current(), !selected);
        assert_eq!(actor.state().scope.as_ref() == Some(&old_scope), !selected);
        let restored = State::load(&store, false).unwrap();
        assert_eq!(
            editor::record(&restored, "synthetic-host", None)
                .unwrap()
                .authorization,
            replacement.authorization
        );
    }
}

#[test]
fn password_exchange_metadata_race_rechecks_version_before_dispatching_authorized_probe() {
    let (mut actor, store, network) = actor();
    let before = actor.state().current().unwrap();
    let scope = actor.state().scope.clone().unwrap();
    actor.connect(json!({"id":"synthetic-host","version":"legacy","url":"https://replacement.invalid","password":"synthetic-password"}),HostReply::default());
    actor
        .immediate("connection.rename", &edit("Password race winner"))
        .unwrap();
    complete_probe(
        &mut actor,
        200,
        json!({"clientToken":"synthetic-issued-too-late"}),
    );
    assert!(actor.jobs.is_empty());
    assert_eq!(
        network.requests.lock().unwrap().len(),
        1,
        "stale password completion must not start the second probe"
    );
    let restored = State::load(&store, false).unwrap();
    let current = restored.current().unwrap();
    assert_eq!(current.label, "Password race winner");
    assert_eq!(current.token, before.token);
    assert_eq!(current.authorization, before.authorization);
    assert_eq!(actor.state().scope, Some(scope));
}
#[test]
fn reauthorization_probe_failure_metadata_race_and_durable_failure_preserve_prior_authority() {
    for mode in [0, 1, 2] {
        let (mut actor, store, _) = actor();
        let before = actor.state().current().unwrap();
        let scope = actor.state().scope.clone().unwrap();
        let browser = actor.browser.capture(&scope).unwrap();
        actor.connect(json!({"id":"synthetic-host","version":"legacy","url":"https://replacement.invalid","token":"synthetic-fresh-token"}),HostReply::default());
        if mode == 1 {
            actor
                .immediate("connection.rename", &edit("Concurrent name"))
                .unwrap();
        }
        if mode == 2 {
            store.fail.store(true, Ordering::Release);
        }
        complete_probe(
            &mut actor,
            if mode == 0 { 401 } else { 200 },
            json!({"ok":mode!=0}),
        );
        let current = actor.state().current().unwrap();
        assert_eq!(current.token, before.token);
        assert_eq!(current.authorization, before.authorization);
        assert_eq!(current.url, before.url);
        assert_eq!(actor.state().scope, Some(scope));
        assert!(browser.current());
        assert_eq!(
            current.label,
            if mode == 1 {
                "Concurrent name"
            } else {
                "Synthetic"
            }
        );
    }
}
#[test]
fn saved_legacy_records_roundtrip_versions_and_relay_is_never_silently_rewritten() {
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let original = store.read().unwrap().unwrap();
    assert!(!String::from_utf8_lossy(&original).contains("editorVersion"));
    let mut value: Value = serde_json::from_slice(&original).unwrap();
    value["connections"][0]["transport"] = json!("relay");
    value["connections"][0]["relay"] =
        json!({"relayUrl":"wss://relay.invalid","serverId":"synthetic"});
    store.write(&serde_json::to_vec(&value).unwrap()).unwrap();
    let before = store.read().unwrap();
    assert!(State::load(&store, false).is_err());
    assert_eq!(store.read().unwrap(), before);
    value = serde_json::from_slice(&original).unwrap();
    value["connections"][0]["editorVersion"] = json!(42);
    store.write(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(State::load(&store, false).is_err());
}

#[test]
fn real_quickjs_editor_wire_password_reauthorization_and_inflight_version_race_use_native_actor() {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (entered, waiting) = mpsc::sync_channel(1);
    let (release, released) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        let started = Instant::now();
        let mut requests = 0;
        while requests < 3 && started.elapsed() < Duration::from_secs(15) {
            let stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("synthetic accept: {error}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            let mut length = 0;
            let mut auth = None;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                let (key, value) = line.split_once(':').unwrap();
                if key.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap();
                }
                if key.eq_ignore_ascii_case("authorization") {
                    auth = Some(value.trim().to_owned());
                }
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            let body = if requests == 0 {
                assert_eq!(first, "POST /auth/session HTTP/1.1\r\n");
                assert!(
                    auth.is_none(),
                    "saved bearer must not cross into password exchange"
                );
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["password"], "synthetic-password");
                assert_eq!(body["issueClientToken"], true);
                json!({"clientToken":"synthetic-issued-credential"})
            } else {
                assert_eq!(first, "GET /api/config/settings HTTP/1.1\r\n");
                assert!(bytes.is_empty());
                assert_eq!(
                    auth.as_deref(),
                    Some(if requests == 1 {
                        "Bearer synthetic-issued-credential"
                    } else {
                        "Bearer synthetic-racing-credential"
                    })
                );
                if requests == 2 {
                    entered.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(10)).unwrap();
                }
                json!({"ok":true})
            };
            let body = body.to_string();
            write!(reader.get_mut(),"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            requests += 1;
        }
        assert_eq!(requests, 3);
    });
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let original = State::load(&store, false).unwrap();
    let original_auth = original.current().unwrap().authorization;
    let host = HostChannel::default();
    let caps = json!({"host":["connection.list","connection.editor","connection.rename","connection.edit","connection.connect"]});
    let owner = install_with(
        &host,
        &caps,
        Box::new(store.clone()),
        nsh_engine::net::network(),
        true,
    )
    .unwrap();
    let failing = store.fail.clone();
    host.handle("test.failStore", move |mut call| {
        let value = call.take_data();
        failing.store(value["fail"].as_bool().unwrap(), Ordering::Release);
        call.resolve(json!(true));
    });
    let waiting = Arc::new(Mutex::new(waiting));
    host.handle("test.waitProbe", move |call| {
        let waiting = waiting.clone();
        let reply = call.into_reply().unwrap();
        std::thread::spawn(move || {
            match waiting
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
            {
                Ok(()) => reply.resolve(json!(true)),
                Err(_) => reply.reject("synthetic_probe_wait_failed"),
            }
        });
    });
    host.handle("test.releaseProbe", move |call| {
        release.try_send(()).unwrap();
        call.resolve(json!(true));
    });
    let (done, result) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = done.send(call.take_data());
    });
    let source = format!(
        r#"import {{host}} from 'nsh';
      (async()=>{{const check=(v,m)=>{{if(!v)throw Error(m);}};const rejects=async(name,value,code)=>{{try{{await host.call(name,value);}}catch(error){{check(String(error).includes(code),String(error));return;}}throw Error('unexpected success '+name);}};
        const saved=await host.call('connection.list',{{}});const id=saved.selected;const read=()=>host.call('connection.editor',{{id}});const legacy=await read();
        check(legacy.version==='legacy'&&!('token' in legacy)&&!('authorizationID' in legacy),'private descriptor');
        const noop=await host.call('connection.edit',{{id,version:legacy.version,label:'  Synthetic  ',url:'HTTPS://HOST.invalid:443/'}});check(noop.runtimeScope.lease===saved.runtimeScope.lease&&(await read()).version==='legacy','noop');
        const renamed=await host.call('connection.rename',{{id,version:legacy.version,label:'  Renamed  '}});const current=await read();check(current.label==='Renamed'&&current.version!=='legacy'&&renamed.runtimeScope.lease===saved.runtimeScope.lease,'metadata CAS');
        await rejects('connection.rename',{{id,version:legacy.version,label:'stale'}},'connection_editor_stale');
        await rejects('connection.edit',{{id,version:current.version,label:'cross',url:'https://new.invalid'}},'connection_editor_pairing_required');
        await host.call('test.failStore',{{fail:true}});await rejects('connection.rename',{{id,version:current.version,label:'lost'}},'connection_editor_storage');await host.call('test.failStore',{{fail:false}});check((await read()).version===current.version,'failed write');
        await rejects('connection.connect',{{id,version:current.version,url:{origin}}},'connection_editor_pairing_required');
        const authorized=await host.call('connection.connect',{{id,version:current.version,label:'Authorized',url:{origin},password:'synthetic-password'}});
        check(authorized.selected===id&&authorized.runtimeInvalidated===true&&authorized.runtimeScope.lease!==saved.runtimeScope.lease,'reauthorize');
        check(!JSON.stringify(authorized).includes('synthetic-issued-credential')&&!JSON.stringify(authorized).includes('synthetic-test-token'),'credential leak');
        const replacement=await read();check(replacement.version!==current.version&&replacement.url==={origin},'replacement descriptor');
        const pending=host.call('connection.connect',{{id,version:replacement.version,label:'Must not win',url:{origin},token:'synthetic-racing-credential'}}).then(()=>({{ok:true}}),error=>({{error:String(error)}}));
        await host.call('test.waitProbe',{{}});await host.call('connection.rename',{{id,version:replacement.version,label:'Race winner'}});await host.call('test.releaseProbe',{{}});
        const failed=await pending;check(failed.error&&failed.error.includes('connection_editor_stale'),'inflight CAS');check((await read()).label==='Race winner','late overwrite');
        host.post('test.result',{{ok:true}});
      }})().catch(error=>host.post('test.result',{{error:String(error)}}));"#,
        origin = json!(origin)
    );
    let engine = engine(host, source);
    let result = result.recv_timeout(Duration::from_secs(20)).unwrap();
    assert_eq!(result, json!({"ok":true}));
    drop(engine);
    drop(owner);
    server.join().unwrap();
    let restored = State::load(&store, true).unwrap();
    let connection = restored.current().unwrap();
    assert_eq!(connection.id, "synthetic-host");
    assert_eq!(connection.label, "Race winner");
    assert_eq!(connection.used, 1.);
    assert_eq!(connection.token, "synthetic-issued-credential");
    assert_ne!(connection.authorization, original_auth);
    assert!(connection.editor_version.is_some());
}

#[test]
fn production_document_install_keeps_pending_receipts_through_metadata_and_retires_with_actor_scope()
 {
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let network = Arc::new(FakeNetwork::default());
    let host = HostChannel::default();
    let caps = json!({"host":["connection.list","connection.editor","connection.rename","connection.select","desktop.documents.save","desktop.documents.status","desktop.documents.cancel"]});
    let owner = install_with(&host, &caps, Box::new(store), network.clone(), false).unwrap();
    let services = owner.services();
    let (port, inbox) = crate::documents::channel();
    services.install_documents(&host, port.clone()).unwrap();
    assert_eq!(
        services.install_documents(&host, port).unwrap_err(),
        "documents_install_not_available"
    );
    let queued = Arc::new(Mutex::new(None));
    let taken = queued.clone();
    let inbox = Mutex::new(inbox);
    host.handle("test.takeSave", move |call| {
        let mut slot = taken.lock().unwrap();
        assert!(slot.is_none());
        *slot = inbox.lock().unwrap().try_recv();
        assert!(slot.is_some());
        call.resolve(json!(true));
    });
    let dropped = queued.clone();
    host.handle("test.dropSave", move |call| {
        drop(dropped.lock().unwrap().take());
        call.resolve(json!(true));
    });
    let stopped = services.clone();
    host.handle("test.shutdown", move |call| {
        stopped.shutdown();
        call.resolve(json!(true));
    });
    let (done, result) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = done.send(call.take_data());
    });
    let source = r#"import {host} from 'nsh';
      (async()=>{const check=(v,m)=>{if(!v)throw Error(m);};const rejects=async(name,value,code)=>{try{await host.call(name,value);}catch(error){check(String(error).includes(code),String(error));return;}throw Error('unexpected success '+name);};
        const saved=await host.call('connection.list',{});const expectedHost=saved.runtimeScope;const id=saved.selected;
        const control={requestID:'synthetic_export_one',ownerID:'synthetic_owner',expectedHost};
        const save=()=>({...control,filename:'synthetic.md',content:'# Synthetic only',format:'markdown'});
        await rejects('desktop.documents.save',{...save(),expectedHost:{...expectedHost,lease:'00000000-0000-4000-8000-000000000000'}},'documents_scope_retired');
        const pending=host.call('desktop.documents.save',save());
        check((await host.call('desktop.documents.status',control)).state==='pending','real handler replaced fallback');await host.call('test.takeSave',{});
        const editor=await host.call('connection.editor',{id});const renamed=await host.call('connection.rename',{id,version:editor.version,label:'Export still owned'});
        check(renamed.runtimeScope.lease===expectedHost.lease&&(await host.call('desktop.documents.status',control)).state==='pending','metadata retired save');
        await rejects('desktop.documents.save',save(),'documents_busy_or_request_reused');
        const selected=await host.call('connection.select',{id});check(selected.runtimeScope.lease!==expectedHost.lease,'lease rotation');
        await rejects('desktop.documents.status',control,'documents_scope_retired');await host.call('test.dropSave',{});
        const dropped=await pending;check(dropped.state==='error'&&dropped.error==='documents_owner_unavailable'&&!('path' in dropped),'unpresented job never pretends saved');
        const next={...control,requestID:'synthetic_export_two',expectedHost:selected.runtimeScope};
        const second=host.call('desktop.documents.save',{...save(),...next});check((await host.call('desktop.documents.status',next)).state==='pending','new lease owner');await host.call('test.takeSave',{});
        await host.call('test.shutdown',{});await rejects('desktop.documents.status',next,'documents_owner_unavailable');await host.call('test.dropSave',{});
        const final=await second;check(final.state==='error'&&!JSON.stringify(final).includes('Synthetic only')&&!('path' in final),'stopped owner receipt');host.post('test.result',{ok:true});
      })().catch(error=>host.post('test.result',{error:String(error)}));"#;
    let engine = engine(host, source.into());
    assert_eq!(
        result.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    assert!(queued.lock().unwrap().is_none());
    assert!(network.requests.lock().unwrap().is_empty());
    assert!(!crate::documents::is_presenting());
    let (port, _) = crate::documents::channel();
    assert_eq!(
        services
            .install_documents(&HostChannel::default(), port)
            .unwrap_err(),
        "documents_install_not_available"
    );
    drop(engine);
    drop(owner);
}
