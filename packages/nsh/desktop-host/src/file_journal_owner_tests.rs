//! Production fallback override + native window ownership. Synthetic private disk only.
use super::*;
use std::{fs, time::Instant};

#[test]
fn production_window_file_journal_survives_actor_metadata_leases_removal_and_cold_restore() {
    let directory = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("nsh-host-journal-{}", vault::id().unwrap()));
    fs::create_dir(&directory).unwrap();
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let host = HostChannel::default();
    let caps = json!({"host":["connection.list","connection.select","connection.remove","connection.editor","connection.rename",
        "desktop.files.journal.snapshot","desktop.files.journal.commit","desktop.files.journal.sync"]});
    let owner = install_with(
        &host,
        &caps,
        Box::new(store),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    let services = owner.services();
    services.install_file_journal(&host, &directory).unwrap();
    assert_eq!(
        services
            .install_file_journal(&host, &directory)
            .unwrap_err(),
        "file_journal_install_not_available"
    );
    let shutdown = services.clone();
    host.handle("test.shutdown", move |call| {
        shutdown.shutdown();
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let source = r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};const journal=(n,v)=>host.call('desktop.files.journal.'+n,v);
      const initial=await journal('snapshot',{});check(initial.status==='ready'&&initial.version===0,'fallback overridden');
      const records={};for(const hostID of ['synthetic-host','unselected-host']){
        const authorityKey=hostID+'-authorization';const directory='/synthetic';const path=directory+'/source.ts';
        const scope={host:{hostID},authorityKey,sessionID:'session',directory};
        const scopeKey=JSON.stringify([hostID,authorityKey,'session',directory]);
        records['desktop-file-journal-v1:'+JSON.stringify([scopeKey,path])]=JSON.stringify({version:1,scope,path,text:'未发送草稿',base:'base',wire:'base',eol:'\n',bom:false,pending:null,conflict:false});
      }
      const scope={host:{hostID:'unselected-host'},authorityKey:'unselected-host-authorization',sessionID:null,directory:'/synthetic'};
      records['desktop-file-operation-v1:'+JSON.stringify(['unselected-host',scope.authorityKey,null,scope.directory])]=JSON.stringify({version:1,scope,command:{kind:'rename',path:'/synthetic/source.ts',name:'next.ts'},phase:'prepared'});
      const committed=await journal('commit',{expectedVersion:0,requestID:'window-request',records});check(committed.status==='ready'&&committed.version===1,'real commit');
      const sync=await journal('sync',{version:1,requestID:'window-request'});check(JSON.stringify(sync)===JSON.stringify(committed),'barrier exact receipt');
      const saved=await host.call('connection.list',{});const editor=await host.call('connection.editor',{id:saved.selected});await host.call('connection.rename',{id:saved.selected,version:editor.version,label:'Metadata'});
      await host.call('connection.select',{id:saved.selected});await host.call('connection.remove',{id:saved.selected});
      const after=await journal('snapshot',{});check(JSON.stringify(after)===JSON.stringify(committed)&&Object.keys(after.records).length===3,'all partitions survive Host retirement');
      const stale=await journal('commit',{expectedVersion:0,requestID:'stale-request',records:{}});check(stale.status==='denied','stale CAS cannot replace');
      const forged=await journal('snapshot',{expectedHost:{hostID:'unselected-host'}});check(forged.status==='denied','no Host filter/schema bypass');
      await host.call('test.shutdown',{});check((await journal('snapshot',{})).status==='denied','window shutdown closes owner');host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#;
    let engine = engine(host, source.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    assert!(
        services
            .install_file_journal(&HostChannel::default(), &directory)
            .is_err()
    );
    drop(engine);
    drop(owner);
    drop(services);

    // Worker observes the dropped native owner asynchronously. Retry only lock acquisition,
    // never a commit; this is a fresh-process equivalent of the stable primary namespace.
    let host = HostChannel::default();
    let deadline = Instant::now() + Duration::from_secs(2);
    let journal = loop {
        match crate::file_journal::install(&host, &directory, "primary") {
            Ok(owner) => break owner,
            Err("file_journal_owner_conflict") if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(error) => panic!("synthetic cold restore failed: {error}"),
        }
    };
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let cold = super::engine(host,r#"import {host} from 'nsh';(async()=>{
      const snapshot=await host.call('desktop.files.journal.snapshot',{});const barrier=await host.call('desktop.files.journal.sync',{version:1,requestID:'window-request'});
      host.post('test.result',{ok:snapshot.status==='ready'&&snapshot.version===1&&Object.keys(snapshot.records).length===3&&JSON.stringify(snapshot)===JSON.stringify(barrier)});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ok":true})
    );
    drop(cold);
    drop(journal);
    // Unlink only known files in this test's freshly-created directory.
    fs::remove_file(directory.join("file-journal-v1/primary/snapshots.bin")).unwrap();
    fs::remove_dir(directory.join("file-journal-v1/primary")).unwrap();
    fs::remove_dir(directory.join("file-journal-v1")).unwrap();
    fs::remove_dir(directory).unwrap();
}
