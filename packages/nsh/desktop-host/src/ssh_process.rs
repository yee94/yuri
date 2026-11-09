//! Direct executable invocation only. Fixed POSIX remote programs go through SSH stdin;
//! neither a local shell nor a JS-supplied command/option is accepted.
use super::*;
use std::{io::{Read, Write}, net::TcpListener, path::PathBuf, process::{Child, Command, Stdio}, sync::mpsc, time::{Duration, Instant}};

pub struct NativeDriver { executable: PathBuf, #[cfg(test)] io_running:std::sync::atomic::AtomicUsize }
impl NativeDriver {
    /// The native installer/actor supplies an OS-owned OpenSSH executable, never a renderer path.
    pub fn new(executable: PathBuf) -> Result<Self> {
        if !executable.is_absolute() || !matches!(executable.file_name().and_then(|s| s.to_str()), Some("ssh" | "ssh.exe")) { return Err(Error::Invalid); }
        Ok(Self { executable, #[cfg(test)] io_running:std::sync::atomic::AtomicUsize::new(0) })
    }
    fn command(&self, instance: &Instance) -> Result<Command> {
        let mut command = Command::new(&self.executable);
        command.args(base_arguments(instance)?);
        command.env("SSH_ASKPASS_REQUIRE", "never").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // Stable std API; target executable is ssh.exe, not cmd, .cmd or raw_arg.
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        Ok(command)
    }
    fn program(&self, instance: &Instance, source: String, cancel: &Cancellation, timeout: Duration) -> Result<Value> {
        self.program_limits(instance,source,cancel,timeout,64*1024,64*1024)
    }
    fn program_limits(&self, instance:&Instance,source:String,cancel:&Cancellation,timeout:Duration,input_limit:usize,output_limit:usize)->Result<Value>{
        if source.len() > input_limit { return Err(Error::Invalid); }
        cancel.check()?;
        let mut command = self.command(instance)?;
        command.arg(destination(instance)).arg("sh -s");
        let mut child = NativeTunnel(command.spawn().map_err(|_| Error::Ssh)?);
        let mut stdin = child.0.stdin.take().ok_or(Error::Ssh)?;
        let stdout = child.0.stdout.take().ok_or(Error::Ssh)?;
        let (tx, rx) = mpsc::sync_channel(1);
        let reader = std::thread::Builder::new().name("ssh-native-stdout".into()).spawn(move || {
            let mut bytes = Vec::new();
            let result = stdout.take(output_limit as u64+1).read_to_end(&mut bytes).map(|_| bytes).map_err(|_| Error::Ssh);
            let _ = tx.send(result);
        }).map_err(|_|Error::Unavailable)?;
        let writer = match std::thread::Builder::new().name("ssh-native-stdin".into()).spawn(move || {stdin.write_all(b"exec node - <<'YURI_NATIVE_SSH_PROGRAM'\n")?;stdin.write_all(source.as_bytes())?;stdin.write_all(b"\nYURI_NATIVE_SSH_PROGRAM\n")}){Ok(writer)=>writer,Err(_)=>{child.close();let _=reader.join();return Err(Error::Unavailable);}};
        let deadline = Instant::now() + timeout;
        let mut output = None;
        let result = loop {
            if let Err(error) = cancel.check() { break Err(error); }
            if Instant::now() >= deadline { break Err(Error::Ssh); }
            if output.is_none() && let Ok(bytes) = rx.try_recv() { output = Some(bytes); }
            if output.as_ref().is_some_and(|v| v.as_ref().map_or(true, |bytes| bytes.len() > output_limit)) { break Err(Error::Ssh); }
            match child.0.try_wait() {
                Ok(Some(status)) => { if !status.success() { break Err(Error::Ssh); } break Ok(()); },
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => break Err(Error::Ssh),
            }
        };
        if result.is_err() { child.close(); }
        let _ = child.0.wait();
        let written = writer.join().map_err(|_| Error::Ssh)?.map_err(|_| Error::Ssh);
        let _ = reader.join();
        result?; written?; cancel.check()?;
        let bytes = output.unwrap_or_else(|| rx.recv().unwrap_or(Err(Error::Ssh)))?;
        if bytes.len() > output_limit { return Err(Error::Ssh); }
        serde_json::from_slice(&bytes).map_err(|_| Error::Ssh)
    }
}
#[cfg(test)]
impl super::io::ProgramTransport for NativeDriver {
    fn exchange(&self,instance:&Instance,request:&Value,cancel:&Cancellation)->Result<Value>{
        self.io_running.fetch_update(Ordering::AcqRel,Ordering::Acquire,|n|if n<2{Some(n+1)}else{None}).map_err(|_|Error::Busy)?;
        struct Permit<'a>(&'a std::sync::atomic::AtomicUsize);impl Drop for Permit<'_>{fn drop(&mut self){self.0.fetch_sub(1,Ordering::AcqRel);}}
        let _permit=Permit(&self.io_running);cancel.check()?;
        let source=format!("const request={};\n{}",request,super::io::file_program());
        let limit=super::io::MAX_BYTES*8/3+32*1024*1024;
        self.program_limits(instance,source,cancel,Duration::from_secs(300),limit,limit)
    }
}
fn destination(instance: &Instance) -> String { format!("{}@{}", instance.user, instance.host) }
pub fn base_arguments(instance: &Instance) -> Result<Vec<String>> {
    Instance::parse(&instance.public())?;
    let null_config = if cfg!(target_os = "windows") { "NUL" } else { "/dev/null" };
    Ok(["-F", null_config, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "ExitOnForwardFailure=yes", "-p"].into_iter().map(str::to_owned).chain([instance.port.to_string()]).collect())
}
pub fn forward_arguments(instance: &Instance, local_port: u16) -> Result<Vec<String>> {
    if local_port == 0 { return Err(Error::Invalid); }
    let mut args = base_arguments(instance)?;
    args.extend(["-N".into(), "-L".into(), format!("127.0.0.1:{local_port}:127.0.0.1:{}", instance.remote_port), destination(instance)]);
    Ok(args)
}
struct NativeTunnel(Child);
impl Tunnel for NativeTunnel {
    fn alive(&mut self) -> bool { matches!(self.0.try_wait(), Ok(None)) }
    fn close(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}
impl Drop for NativeTunnel { fn drop(&mut self) { self.close(); } }
impl Driver for NativeDriver {
    fn inspect(&self, instance: &Instance, cancel: &Cancellation) -> Result<Inspection> {
        cancel.check()?;
        let value = self.program(instance, INSPECT.into(), cancel, Duration::from_secs(30))?;
        let node_major = value["nodeMajor"].as_u64().ok_or(Error::Runtime)?;
        let version = match &value["version"] { Value::Null => None, Value::String(s) if s.len() <= 80 => Some(s.clone()), _ => return Err(Error::Runtime) };
        Ok(Inspection { version, node_major })
    }
    fn initialize(&self, instance: &Instance, version: &str, password: &Secret, cancel: &Cancellation) -> Result<()> {
        let source = bootstrap_program(instance, version, password)?;
        let value = self.program(instance, source, cancel, Duration::from_secs(300))?;
        if value["ready"] != true || value["port"] != instance.remote_port { return Err(Error::Bootstrap); }
        Ok(())
    }
    fn forward(&self, instance: &Instance, cancel: &Cancellation) -> Result<Forward> {
        cancel.check()?;
        let port = if instance.local_port > 0 { instance.local_port } else {
            // Reserve then release; SSH owns the eventual bind. Authentication, not this selection, proves readiness.
            TcpListener::bind(("127.0.0.1", 0)).and_then(|listener| listener.local_addr()).map_err(|_| Error::Ssh)?.port()
        };
        let mut command = Command::new(&self.executable);
        command.args(forward_arguments(instance, port)?).env("SSH_ASKPASS_REQUIRE", "never").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
        let child = command.spawn().map_err(|_| Error::Ssh)?;
        let mut tunnel = NativeTunnel(child);
        for _ in 0..10 { cancel.check()?; if !tunnel.alive() { return Err(Error::Ssh); } std::thread::sleep(Duration::from_millis(20)); }
        Ok(Forward { port, tunnel: Box::new(tunnel) })
    }
}
const INSPECT: &str = r#"
const {execFileSync} = require('node:child_process');
let version = null;
try { const raw = execFileSync('yuri',['--version'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','ignore'],maxBuffer:65536}).trim(); const match = raw.match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/); if(match) version=match[1]; } catch {}
process.stdout.write(JSON.stringify({nodeMajor:Number(process.versions.node.split('.')[0]),version}));
"#;
/// No untrusted script fragments. Native-only secret is JSON-escaped inside stdin, never argv/env/logs locally.
pub fn bootstrap_program(instance: &Instance, version: &str, password: &Secret) -> Result<String> {
    Instance::parse(&instance.public())?;
    if !instance.managed || !app_version(version) || password.expose().len() < 24 { return Err(Error::Invalid); }
    Ok(format!("const plan = {};\n{}", json!({"version":version,"port":instance.remote_port,"password":password.expose()}), BOOTSTRAP))
}
const BOOTSTRAP: &str = r#"
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const run=(name,args,env=process.env)=>execFileSync(name,args,{env,encoding:'utf8',timeout:180000,maxBuffer:65536,stdio:['ignore','pipe','ignore']}).trim();
const json=(args)=>JSON.parse(run('yuri',args));
const request=async(port,path)=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{redirect:'error',signal:AbortSignal.timeout(5000)}); if(!r.ok) throw Error(); return r.json();};
(async()=>{
 if(Number(process.versions.node.split('.')[0])<22) throw Error();
 const root=path.join(os.homedir(),'.config','yuri'); fs.mkdirSync(root,{recursive:true,mode:0o700});
 const lock=path.join(root,'nsh-ssh-bootstrap.lock'); fs.mkdirSync(lock,{mode:0o700});
 // Never guess a stale lock or remove another live/cancelled bootstrap's ownership.
 try {
 let installed=null; try { installed=run('yuri',['--version']).match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/)?.[1]||null; } catch {}
 if(installed){
  const status=json(['status','--json']); if(!Array.isArray(status.instances)||status.instances.length>64) throw Error();
  const managed=[];
  for(const item of status.instances){
   if(item.runtime!=='cli') continue;
   if(!Number.isInteger(item.port)||item.port<1||item.port>65535) throw Error();
   const info=await request(item.port,'/api/system/info');
   if(typeof info.runtime!=='string'||!info.runtime) throw Error();
   if(info.runtime==='ssh-remote') managed.push(item.port);
   else if(item.port===plan.port) throw Error();
  }
  // Native restart has no daemon password authority. Verify every managed stop before replacing files.
  for(const port of managed){const stopped=json(['stop','--port',String(port),'--json']); if(['error','warning'].includes(stopped.status)||!Array.isArray(stopped.results)||!stopped.results.some(x=>x.port===port&&x.stopped===true)) throw Error();}
 }
 if(installed!==plan.version) run('npm',['install','--global',`@yuriai/web@${plan.version}`]);
 let opencode=''; try {opencode=run('opencode',['--version']);}catch{}
 if(!/\b2\.[0-9]+\.[0-9]+\b/.test(opencode)) run('npm',['install','--global','@opencode/cli@2']);
 const current=run('yuri',['--version']).match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/)?.[1]; if(current!==plan.version) throw Error();
 run('yuri',['serve','--hostname','127.0.0.1','--port',String(plan.port)],{...process.env,YURI_RUNTIME:'ssh-remote',YURI_UI_PASSWORD:plan.password});
 await request(plan.port,'/health');
 process.stdout.write(JSON.stringify({ready:true,port:plan.port}));
 } finally {fs.rmdirSync(lock);}
})().catch(()=>{process.exitCode=1;});
"#;
