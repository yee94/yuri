use super::*;
use crate::terminal_transport::ws::tests::Server;

#[test]
fn committed_actor_authority_real_native_ws_hostchannel_quickjs_replay_cursor_and_retirement() {
    let mut server = Server::new("replay");
    let store = MemoryVault::default();
    let mut saved = state();
    saved.connections[0].url = server.origin.clone();
    saved.connections[0].token = "synthetic-ws-token".into();
    saved.persist(&store).unwrap();
    let host = HostChannel::default();
    let caps = json!({"host":["connection.list","connection.select","terminal.capabilities","terminal.restore","terminal.attach","terminal.detach","terminal.input","terminal.close"]});
    let owner = install_with(
        &host,
        &caps,
        Box::new(store),
        nsh_engine::net::network(),
        true,
    )
    .unwrap();
    let dir = std::env::temp_dir().join(format!("synthetic-ws-host-{}", vault::id().unwrap()));
    std::fs::create_dir(&dir).unwrap();
    let catalog = dir.join("terminal.json");
    std::fs::write(&catalog,json!({"synthetic-host":{"schema":1,"hostID":"synthetic-host","directories":[{"directory":"/synthetic","activeId":"tab","tabs":[{"id":"tab","sessionId":"synthetic-session","lifecycle":"running"}]}]}}).to_string()).unwrap();
    owner
        .services()
        .install_terminal(
            &host,
            crate::terminal_viewport::Registration::default(),
            catalog.clone(),
        )
        .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let source = r#"import {host} from 'nsh';
      (async()=>{const check=(v,m)=>{if(!v)throw Error(m);};const saved=await host.call('connection.list',{});const base={expectedHost:saved.runtimeScope,owner:'tab',directory:'/synthetic',sessionId:'synthetic-session'};
        const cap=await host.call('terminal.capabilities',{expectedHost:base.expectedHost});check(cap.wsAvailable&&cap.wsVersion===2&&cap.scope==='native-opaque','native WS capability');
        await host.call('terminal.restore',base);const events=[];let wake;host.on('terminal.event',value=>{events.push(value);if(wake)wake();});
        const take=async test=>{for(;;){const index=events.findIndex(test);if(index>=0)return events.splice(index,1)[0];await new Promise(resolve=>wake=resolve);wake=null;}};
        await host.call('terminal.attach',{...base,attachment:1,cursor:0});const connected=await take(v=>v.type==='connected');check(connected.transport==='ws'&&connected.replayUnavailable===false,'no fake SSE');
        const first=await take(v=>v.type==='data');check(first.id===1&&first.cursor===1&&!first.replayGap&&first.data==='原生首帧','native output');
        check(await host.call('terminal.input',{...base,data:'中\0\r\n'})===true,'native input');const gap=await take(v=>v.type==='data');check(gap.id===2&&gap.cursor===3&&gap.replayGap,'independent cursor');
        await take(v=>v.type==='error');let forged=false;try{await host.call('terminal.attach',{...base,attachment:2,cursor:99});}catch{forged=true;}check(forged,'presentation/future ACK cannot advance server cursor');
        await host.call('terminal.attach',{...base,attachment:2,cursor:3});await take(v=>v.type==='connected');const replay=await take(v=>v.type==='data');check(replay.id===3&&replay.cursor===4&&replay.data==='replayed'&&!replay.replayGap,'replay duplicate suppressed');
        await host.call('terminal.detach',{expectedHost:base.expectedHost,owner:'tab',attachment:1});check(!events.some(v=>v.type==='data'&&v.data==='duplicate'),'old detach/current replay');
        await host.call('connection.select',{id:saved.selected});let stale=false;try{await host.call('terminal.close',base);}catch{stale=true;}check(stale,'retired close cannot kill PTY');
        host.post('test.result',{ok:true});
      })().catch(error=>host.post('test.result',{error:String(error)}));"#;
    let engine = engine(host, source.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(20)).unwrap(),
        json!({"ok":true})
    );
    drop(engine);
    drop(owner);
    server.finish();
    let metadata = std::fs::read_to_string(&catalog).unwrap();
    assert!(!metadata.contains("synthetic-ws-token"));
    assert!(!metadata.contains("原生首帧"));
    std::fs::remove_file(catalog).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

#[test]
fn native_host_prebind_fallback_is_explicit_but_write_unknown_never_falls_back_or_replays() {
    for mode in ["fallback", "unknown"] {
        let mut server = Server::new(mode);
        let store = MemoryVault::default();
        let mut saved = state();
        saved.connections[0].url = server.origin.clone();
        saved.connections[0].token = "synthetic-ws-token".into();
        saved.persist(&store).unwrap();
        let host = HostChannel::default();
        let caps = json!({"host":["connection.list","terminal.restore","terminal.attach","terminal.input"]});
        let owner = install_with(
            &host,
            &caps,
            Box::new(store),
            nsh_engine::net::network(),
            true,
        )
        .unwrap();
        let dir =
            std::env::temp_dir().join(format!("synthetic-ws-boundary-{}", vault::id().unwrap()));
        std::fs::create_dir(&dir).unwrap();
        let catalog = dir.join("terminal.json");
        std::fs::write(&catalog,json!({"synthetic-host":{"schema":1,"hostID":"synthetic-host","directories":[{"directory":"/synthetic","activeId":"tab","tabs":[{"id":"tab","sessionId":"synthetic-session","lifecycle":"running"}]}]}}).to_string()).unwrap();
        owner
            .services()
            .install_terminal(
                &host,
                crate::terminal_viewport::Registration::default(),
                catalog.clone(),
            )
            .unwrap();
        let (tx, rx) = mpsc::channel();
        host.handle("test.result", move |mut call| {
            let _ = tx.send(call.take_data());
        });
        let source = format!(
            r#"import {{host}} from 'nsh';(async()=>{{
          const check=(v,m)=>{{if(!v)throw Error(m);}};const saved=await host.call('connection.list',{{}});const base={{expectedHost:saved.runtimeScope,owner:'tab',directory:'/synthetic',sessionId:'synthetic-session'}};
          await host.call('terminal.restore',base);const queue=[];let wake;host.on('terminal.event',value=>{{queue.push(value);if(wake)wake();}});
          const take=async test=>{{for(;;){{const index=queue.findIndex(test);if(index>=0)return queue.splice(index,1)[0];await new Promise(resolve=>wake=resolve);wake=null;}}}};
          await host.call('terminal.attach',{{...base,attachment:1,cursor:0}});const connected=await take(v=>v.type==='connected');
          if('{mode}'==='fallback'){{check(connected.transport==='sse'&&connected.replayUnavailable===true,'honest fallback');const data=await take(v=>v.type==='data');check(data.data==='SSE-with-explicit-gap'&&data.cursor===0,'fallback output');}}
          else{{check(connected.transport==='ws','native bind');try{{await host.call('terminal.input',{{...base,data:'once-only'}});}}catch(error){{check(String(error).includes('input_unknown'),'unexpected rejection');}}
            const failure=await take(v=>v.type==='error');check(failure.code==='input_unknown','WRITE_FAIL stays unknown');let blocked=false;try{{await host.call('terminal.input',{{...base,data:'must-not-replay'}});}}catch(error){{blocked=String(error).includes('input_unknown');}}check(blocked,'unknown native latch');}}
          host.post('test.result',{{ok:true}});
        }})().catch(error=>host.post('test.result',{{error:String(error)}}));"#
        );
        let engine = engine(host, source);
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(20)).unwrap(),
            json!({"ok":true}),
            "{mode}"
        );
        drop(engine);
        drop(owner);
        server.finish();
        std::fs::remove_file(catalog).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
