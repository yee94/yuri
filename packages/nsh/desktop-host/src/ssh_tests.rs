use super::*;
use std::{sync::{Mutex, Condvar, atomic::{AtomicUsize, Ordering}}, time::{Duration, Instant}};

fn row(id:&str)->Instance { Instance::parse(&json!({"id":id,"label":"Synthetic SSH","host":"ssh.example.invalid","user":"fixture","port":22,"remotePort":3210,"localPort":0,"managed":true})).unwrap() }
#[derive(Default)]
struct Gate { block: Mutex<bool>, changed: Condvar }
impl Gate { fn wait(&self) { let mut blocked=self.block.lock().unwrap(); while *blocked { blocked=self.changed.wait(blocked).unwrap(); } } fn hold(&self){*self.block.lock().unwrap()=true;} fn release(&self){*self.block.lock().unwrap()=false;self.changed.notify_all();} }
struct Actor {
    saves: AtomicUsize, authorized: AtomicUsize, retired: AtomicUsize, quarantined: AtomicUsize, health_entered: AtomicUsize,
    gate: Gate, health_gate: Gate, save_error: Mutex<Option<Error>>, restored: Mutex<Option<Error>>, reenter: Mutex<Option<std::sync::Weak<Owner>>>,
}
impl Default for Actor { fn default()->Self { Self { saves:AtomicUsize::new(0),authorized:AtomicUsize::new(0),retired:AtomicUsize::new(0),quarantined:AtomicUsize::new(0),health_entered:AtomicUsize::new(0),gate:Gate::default(),health_gate:Gate::default(),save_error:Mutex::new(None),restored:Mutex::new(None),reenter:Mutex::new(None) } } }
impl ActorPort for Actor {
    fn load(&self)->Result<Registry>{Ok(Registry{revision:1,instances:vec![row("a"),row("b"),row("c"),row("d"),row("e")]})}
    fn save(&self,revision:u64,_:&[Instance])->Result<u64>{self.saves.fetch_add(1,Ordering::SeqCst); if let Some(owner)=self.reenter.lock().unwrap().as_ref().and_then(|v|v.upgrade()){owner.snapshot()?;} match *self.save_error.lock().unwrap(){Some(error)=>Err(error),None=>Ok(revision+1)}}
    fn password(&self,_:&Instance)->Result<Secret>{Secret::new("synthetic-native-password-only-123".into())}
    fn restore(&self,_:&Instance,_:&Cancellation)->Result<Option<Committed>>{match *self.restored.lock().unwrap(){Some(error)=>Err(error),None=>Ok(None)}}
    fn authorize(&self,instance:&Instance,_:u16,_:&Secret,_:&Cancellation)->Result<Committed>{self.authorized.fetch_add(1,Ordering::SeqCst);self.gate.wait();Ok(Committed{connection_id:format!("connection-{}",instance.id),receipt:format!("native-receipt-{}",instance.id)})}
    fn healthy(&self,_:&Committed)->Result<bool>{if let Some(owner)=self.reenter.lock().unwrap().as_ref().and_then(|v|v.upgrade()){owner.snapshot()?;}self.health_entered.fetch_add(1,Ordering::SeqCst);self.health_gate.wait();Ok(true)}
    fn retire(&self,_:&Committed)->Result<()>{self.retired.fetch_add(1,Ordering::SeqCst);Ok(())}
    fn quarantine(&self){self.quarantined.fetch_add(1,Ordering::SeqCst);}
}
struct FakeDriver { inspected:AtomicUsize, initialized:AtomicUsize, gate:Gate, closed:Arc<AtomicUsize>, alive:Arc<std::sync::atomic::AtomicBool> }
impl Default for FakeDriver { fn default()->Self{Self{inspected:AtomicUsize::new(0),initialized:AtomicUsize::new(0),gate:Gate::default(),closed:Arc::new(AtomicUsize::new(0)),alive:Arc::new(std::sync::atomic::AtomicBool::new(true))}} }
struct FakeTunnel(Arc<AtomicUsize>,Arc<std::sync::atomic::AtomicBool>);
impl Tunnel for FakeTunnel{fn alive(&mut self)->bool{self.1.load(Ordering::SeqCst)}fn close(&mut self){self.0.fetch_add(1,Ordering::SeqCst);}}
impl Driver for FakeDriver {
    fn inspect(&self,_:&Instance,cancel:&Cancellation)->Result<Inspection>{self.inspected.fetch_add(1,Ordering::SeqCst);self.gate.wait();cancel.check()?;Ok(Inspection{version:Some("1.2.3".into()),node_major:24})}
    fn initialize(&self,_:&Instance,_:&str,_:&Secret,_:&Cancellation)->Result<()>{self.initialized.fetch_add(1,Ordering::SeqCst);Ok(())}
    fn forward(&self,_:&Instance,_:&Cancellation)->Result<Forward>{Ok(Forward{port:4210,tunnel:Box::new(FakeTunnel(self.closed.clone(),self.alive.clone()))})}
}
fn fixture()->(Arc<Owner>,Arc<Actor>,Arc<FakeDriver>){let actor=Arc::new(Actor::default());let driver=Arc::new(FakeDriver::default());let owner=Owner::new(actor.clone(),driver.clone(),"1.2.3".into()).unwrap();(owner,actor,driver)}
fn wait(check:impl Fn()->bool){let deadline=Instant::now()+Duration::from_secs(3);while !check(){assert!(Instant::now()<deadline,"synthetic operation timed out");std::thread::sleep(Duration::from_millis(2));}}
fn status(owner:&Owner,id:&str)->Value{owner.snapshot().unwrap()["statuses"].as_array().unwrap().iter().find(|v|v["id"]==id).unwrap().clone()}

#[test]fn exact_schema_rejects_commands_credentials_and_relay(){let mut value=row("a").public();for key in ["sshCommand","password","token","relay","relayUrl"]{value[key]=json!("not-allowed");assert_eq!(Instance::parse(&value).unwrap_err(),Error::Invalid);value.as_object_mut().unwrap().remove(key);}for host in ["-oProxyCommand=bad","$(bad)","user@host","https://host","host\n"]{value["host"]=json!(host);assert!(Instance::parse(&value).is_err());}}
#[test]fn strict_openssh_arguments_not_local_shell(){let args=process::forward_arguments(&row("a"),4210).unwrap();assert!(args.contains(&"StrictHostKeyChecking=yes".into()));assert!(args.contains(&"BatchMode=yes".into()));assert!(args.contains(&"ProxyCommand=none".into()));assert_eq!(args.last().unwrap(),"fixture@ssh.example.invalid");assert!(args.contains(&"127.0.0.1:4210:127.0.0.1:3210".into()));assert!(!args.iter().any(|s|s.contains("password")));}
#[test]fn managed_program_uses_fixed_actions_secret_only_stdin(){let script=process::bootstrap_program(&row("a"),"1.2.3",&Secret::new("synthetic-native-password-only-123".into()).unwrap()).unwrap();assert!(script.contains("['status','--json']"));assert!(script.contains("['stop','--port'"));assert!(script.contains("@opencode/cli@2"));assert!(!script.contains("kill -"));assert!(!script.contains("relay-host"));}
#[test]fn registry_cas_dedupe_payload_binding_and_reentrant_actor(){let(owner,actor,_)=fixture();*actor.reenter.lock().unwrap()=Some(Arc::downgrade(&owner));assert!(owner.save("save-a",1,row("a")).is_ok());assert!(owner.save("save-a",1,row("a")).is_ok());assert_eq!(actor.saves.load(Ordering::SeqCst),1);assert_eq!(owner.save("save-a",1,row("b")).unwrap_err(),Error::Invalid);assert_eq!(owner.save("save-b",1,row("b")).unwrap_err(),Error::Stale);}
#[test]fn definite_registry_failure_preserves_prior_unknown_quarantines(){let(owner,actor,_)=fixture();*actor.save_error.lock().unwrap()=Some(Error::Storage);assert_eq!(owner.remove("remove-a",1,"a").unwrap_err(),Error::Storage);assert_eq!(owner.snapshot().unwrap()["instances"].as_array().unwrap().len(),5);*actor.save_error.lock().unwrap()=Some(Error::CommitUnknown);assert_eq!(owner.remove("remove-a",1,"a").unwrap_err(),Error::CommitUnknown);assert_eq!(owner.snapshot().unwrap_err(),Error::CommitUnknown);assert_eq!(actor.quarantined.load(Ordering::SeqCst),1);}
#[test]fn concurrent_connect_coalesces_and_only_native_commit_is_ready(){let(owner,actor,driver)=fixture();actor.gate.hold();owner.start("a","connect-a",Intent::Connect).unwrap();wait(||actor.authorized.load(Ordering::SeqCst)==1);owner.start("a","connect-b",Intent::Connect).unwrap();assert_ne!(status(&owner,"a")["phase"],"ready");assert_eq!(driver.initialized.load(Ordering::SeqCst),1);actor.gate.release();wait(||status(&owner,"a")["running"]==false);assert_eq!(status(&owner,"a")["phase"],"ready");let public=owner.snapshot().unwrap().to_string();assert!(!public.contains("native-password"));assert!(!public.contains("native-receipt"));owner.shutdown();assert_eq!(actor.retired.load(Ordering::SeqCst),1);}
#[test]fn cancellation_fences_late_authorize_and_exact_attempt(){let(owner,actor,driver)=fixture();actor.gate.hold();owner.start("a","connect-a",Intent::Connect).unwrap();wait(||actor.authorized.load(Ordering::SeqCst)==1);let attempt=status(&owner,"a")["attempt"].as_u64().unwrap();assert_eq!(owner.cancel("a",attempt+1).unwrap_err(),Error::Stale);owner.cancel("a",attempt).unwrap();actor.gate.release();wait(||actor.retired.load(Ordering::SeqCst)==1);wait(||status(&owner,"a")["running"]==false);assert_eq!(status(&owner,"a")["phase"],"idle");assert_eq!(driver.closed.load(Ordering::SeqCst),1);}
#[test]fn shutdown_fences_late_authorize(){let(owner,actor,driver)=fixture();actor.gate.hold();owner.start("a","connect-a",Intent::Connect).unwrap();wait(||actor.authorized.load(Ordering::SeqCst)==1);owner.shutdown();actor.gate.release();wait(||actor.retired.load(Ordering::SeqCst)==1);assert_eq!(owner.snapshot().unwrap_err(),Error::Unavailable);assert_eq!(driver.closed.load(Ordering::SeqCst),1);}
#[test]fn cancelled_workers_still_count_toward_global_bound(){let(owner,_,driver)=fixture();driver.gate.hold();for (index,id) in ["a","b","c","d"].iter().enumerate(){owner.start(id,&format!("connect-{index}"),Intent::Connect).unwrap();wait(||driver.inspected.load(Ordering::SeqCst)==index+1);let attempt=status(&owner,id)["attempt"].as_u64().unwrap();owner.cancel(id,attempt).unwrap();}assert_eq!(owner.start("e","connect-e",Intent::Connect).unwrap_err(),Error::Busy);driver.gate.release();owner.shutdown();}
#[test]fn restore_failure_falls_back_once_normal_entry_always_initializes(){let(owner,actor,driver)=fixture();*actor.restored.lock().unwrap()=Some(Error::Unavailable);owner.start("a","restore-a",Intent::Restore).unwrap();wait(||status(&owner,"a")["running"]==false);assert_eq!(driver.initialized.load(Ordering::SeqCst),1);owner.start("a","normal-a",Intent::Connect).unwrap();wait(||status(&owner,"a")["running"]==false);assert_eq!(driver.initialized.load(Ordering::SeqCst),2);owner.shutdown();}
#[test]fn check_is_read_only_and_dead_tunnel_schedules_bounded_recovery(){let(owner,actor,driver)=fixture();owner.start("a","check-a",Intent::Check).unwrap();wait(||status(&owner,"a")["running"]==false);assert_eq!(status(&owner,"a")["phase"],"checked");assert_eq!(driver.initialized.load(Ordering::SeqCst),0);assert_eq!(actor.authorized.load(Ordering::SeqCst),0);owner.start("a","connect-a",Intent::Connect).unwrap();wait(||status(&owner,"a")["running"]==false);driver.alive.store(false,Ordering::SeqCst);owner.tick();assert_eq!(status(&owner,"a")["phase"],"reconnecting");for _ in 0..30{owner.tick();}assert_eq!(driver.initialized.load(Ordering::SeqCst),1);owner.cancel("a",status(&owner,"a")["attempt"].as_u64().unwrap()).unwrap();owner.shutdown();}
#[test]fn npm_filter_matches_strings_tuples_objects_and_preserves_jsonc(){let source="\u{feff}{\n// untouched\n\"other\":{\"value\":true},\"plugin\":[\"./local\",[\"@scope/npm@^2\",{\"x\":1}],\"file:///private\",],\"plugins\":[{\"package\":\"good@next\",\"options\":{\"keep\":true}},{\"package\":\"C:\\\\local\"}],}";let output=sync::filter_plugins(source).unwrap();assert!(output.contains("// untouched"));assert!(output.contains("\"other\":{\"value\":true}"));assert!(output.contains("@scope/npm@^2"));assert!(output.contains("good@next"));assert!(!output.contains("./local"));assert!(!output.contains("file:///private"));assert!(!output.contains("C:"));assert_eq!(sync::filter_plugins(&output).unwrap(),output);for invalid in ["{\"plugin\":[],\"plugin\":[]}","{\"plugins\":{}}","[1]","{bad}"]{assert!(sync::filter_plugins(invalid).is_err());}}

#[test]fn health_probe_keeps_public_ready_shape_and_native_sync_grant_then_cancel_retires_it(){
    let(owner,actor,_)=fixture();owner.start("a","connect-a",Intent::Connect).unwrap();wait(||status(&owner,"a")["running"]==false);
    let attempt=status(&owner,"a")["attempt"].as_u64().unwrap();let grant=owner.capture_sync("a",attempt).unwrap();assert!(owner.sync_current(&grant));
    actor.health_gate.hold();*actor.reenter.lock().unwrap()=Some(Arc::downgrade(&owner));let tick=owner.clone();let task=std::thread::spawn(move||tick.tick());wait(||actor.health_entered.load(Ordering::SeqCst)==1);
    // A reentrant registry update on another entity proves no SSH lock is held by health.
    owner.save("health-save",1,row("e")).unwrap();
    let public=status(&owner,"a");assert_eq!(public["phase"],"ready");assert_eq!(public["connectionID"],"connection-a");assert_eq!(public["running"],false);
    assert!(owner.sync_current(&grant));owner.cancel("a",attempt).unwrap();assert!(!owner.sync_current(&grant));actor.health_gate.release();task.join().unwrap();
    assert_eq!(status(&owner,"a")["phase"],"idle");assert_eq!(actor.retired.load(Ordering::SeqCst),1);owner.shutdown();
}

fn file(name:&str,content:&str)->sync::File{sync::File{name:name.into(),content:content.into(),version:"synthetic-v1".into(),mode:0o600}}
struct ConfigFiles {
    local:Mutex<Vec<sync::File>>,remote:Mutex<Vec<sync::File>>,writes:AtomicUsize,result:Mutex<Option<Error>>,receipt:Mutex<Option<bool>>,
}
impl ConfigFiles {fn new(local:Vec<sync::File>,remote:Vec<sync::File>)->Self{Self{local:Mutex::new(local),remote:Mutex::new(remote),writes:AtomicUsize::new(0),result:Mutex::new(None),receipt:Mutex::new(None)}}}
fn clone_files(files:&[sync::File])->Vec<sync::File>{files.to_vec()}
impl sync::Files for ConfigFiles{
    fn read(&self,remote:bool)->Result<Vec<sync::File>>{Ok(clone_files(&if remote{self.remote.lock().unwrap()}else{self.local.lock().unwrap()}))}
    fn replace(&self,remote:bool,_:&str,before:&[sync::File],after:&[sync::File],cancel:&Cancellation)->Result<()>{
        cancel.check()?;let mut target=if remote{self.remote.lock().unwrap()}else{self.local.lock().unwrap()};
        if target.len()!=before.len()||target.iter().zip(before).any(|(a,b)|a.name!=b.name||a.content!=b.content||a.version!=b.version){return Err(Error::Stale);}
        self.writes.fetch_add(1,Ordering::SeqCst);if let Some(error)=*self.result.lock().unwrap(){return Err(error);}*target=clone_files(after);Ok(())
    }
    fn receipt(&self,_:bool,_:&str)->Result<Option<bool>>{Ok(*self.receipt.lock().unwrap())}
}
#[test]fn sync_push_preview_is_metadata_only_then_applies_filtered_exact_snapshot(){
    let files=Arc::new(ConfigFiles::new(vec![file("opencode.jsonc","{\"plugins\":[{\"package\":\"npm-plugin@^2\"},{\"package\":\"./private\"}],\"other\":true}")],vec![file("config.json","{}") ]));
    let owner=sync::SyncOwner::new(files.clone());let preview=owner.preview("push-a",sync::Direction::Push).unwrap();
    assert_eq!(preview["deletes"],json!(["config.json","opencode.json"]));assert!(!preview.to_string().contains("npm-plugin"));assert_eq!(files.writes.load(Ordering::SeqCst),0);
    owner.apply("push-a",&Cancellation::default()).unwrap();let remote=files.remote.lock().unwrap();assert_eq!(remote.len(),1);let text=std::str::from_utf8(&remote[0].content).unwrap();assert!(text.contains("npm-plugin"));assert!(!text.contains("./private"));assert_eq!(owner.apply("push-a",&Cancellation::default()).unwrap_err(),Error::Busy);
}
#[test]fn sync_pull_uses_remote_precedence_and_preserves_unrelated_jsonc(){
    let files=Arc::new(ConfigFiles::new(vec![file("opencode.json","{}")],vec![file("opencode.jsonc","{bad}"),file("config.json","{/*keep*/\"plugin\":[\"file:///private\",\"portable\"]}")]));
    let owner=sync::SyncOwner::new(files.clone());let preview=owner.preview("pull-a",sync::Direction::Pull).unwrap();assert_eq!(preview["files"][0]["name"],"config.json");owner.apply("pull-a",&Cancellation::default()).unwrap();let local=files.local.lock().unwrap();assert_eq!(local[0].name,"config.json");let text=std::str::from_utf8(&local[0].content).unwrap();assert!(text.contains("/*keep*/"));assert!(!text.contains("file:///private"));assert_eq!(files.remote.lock().unwrap().len(),2);
}
#[test]fn sync_invalid_jsonc_or_paths_fail_before_destination_mutation(){
    for input in [file("opencode.jsonc","{bad}"),file("../opencode.json","{}")]{let files=Arc::new(ConfigFiles::new(vec![input],vec![]));let owner=sync::SyncOwner::new(files.clone());assert_eq!(owner.preview("invalid-a",sync::Direction::Push).unwrap_err(),Error::Invalid);assert_eq!(files.writes.load(Ordering::SeqCst),0);}
}
#[test]fn sync_unknown_is_read_only_and_blocks_overlapping_apply_until_exact_receipt(){
    let files=Arc::new(ConfigFiles::new(vec![file("opencode.json","{}")],vec![]));let owner=sync::SyncOwner::new(files.clone());owner.preview("sync-a",sync::Direction::Push).unwrap();owner.preview("sync-b",sync::Direction::Push).unwrap();*files.result.lock().unwrap()=Some(Error::SyncUnknown);
    assert_eq!(owner.apply("sync-a",&Cancellation::default()).unwrap_err(),Error::SyncUnknown);assert_eq!(owner.status("sync-a").unwrap()["phase"],"unknown");assert_eq!(owner.apply("sync-a",&Cancellation::default()).unwrap_err(),Error::Busy);assert_eq!(owner.apply("sync-b",&Cancellation::default()).unwrap_err(),Error::Busy);assert_eq!(files.writes.load(Ordering::SeqCst),1);
    *files.receipt.lock().unwrap()=Some(true);assert_eq!(owner.status("sync-a").unwrap()["phase"],"success");assert_eq!(files.writes.load(Ordering::SeqCst),1);
}
#[test]fn sync_destination_drift_and_cancel_are_not_success(){
    let files=Arc::new(ConfigFiles::new(vec![file("opencode.json","{}")],vec![]));let owner=sync::SyncOwner::new(files.clone());owner.preview("sync-a",sync::Direction::Push).unwrap();files.remote.lock().unwrap().push(file("config.json","{}"));assert_eq!(owner.apply("sync-a",&Cancellation::default()).unwrap_err(),Error::Stale);assert_eq!(owner.status("sync-a").unwrap()["phase"],"failure");assert_eq!(files.writes.load(Ordering::SeqCst),0);
    owner.preview("sync-b",sync::Direction::Push).unwrap();let cancel=Cancellation::default();cancel.cancel();assert_eq!(owner.apply("sync-b",&cancel).unwrap_err(),Error::Cancelled);assert_eq!(files.writes.load(Ordering::SeqCst),0);
}
