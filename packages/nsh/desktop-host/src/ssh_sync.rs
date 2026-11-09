//! Native-only config preview/apply. Payloads stay native; public plans contain metadata only.
//! File transport/backup grants must come from the original actor, never renderer paths.
use super::*;
use std::{collections::HashMap, sync::Mutex};

pub fn npm_plugin(value: &Value) -> bool {
    let value = if let Some(v) = value.as_array() { v.first() } else if value.is_object() { value.get("package") } else { Some(value) };
    let Some(spec) = value.and_then(Value::as_str).map(str::trim) else { return false; };
    let split = if spec.starts_with('@') { spec.find('/').and_then(|slash| spec[slash+1..].find('@').map(|i| slash+1+i)) } else { spec.find('@') };
    let (name, version) = split.map_or((spec,None), |index| (&spec[..index],Some(&spec[index+1..])));
    fn part(s: &str) -> bool { s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) }
    let valid_name = if let Some(scoped) = name.strip_prefix('@') { scoped.split_once('/').is_some_and(|(scope,name)| part(scope) && part(name)) } else { part(name) };
    valid_name && version.is_none_or(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.*+~^<>=| -".contains(&b)))
}
#[derive(Clone)]
struct Token { start: usize, end: usize, kind: u8 }
fn tokens(source: &str) -> Result<(Vec<Token>, Vec<u8>)> {
    let bytes = source.as_bytes(); let mut clean = bytes.to_vec(); let mut result = Vec::new(); let mut i = 0;
    if bytes.starts_with(&[0xef,0xbb,0xbf]) { clean[..3].fill(b' '); i = 3; }
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() { i+=1; continue; }
        if bytes[i..].starts_with(b"//") { let start=i; while i<bytes.len() && bytes[i]!=b'\n' { i+=1; } clean[start..i].fill(b' '); continue; }
        if bytes[i..].starts_with(b"/*") { let start=i; i+=2; while i+1<bytes.len() && !bytes[i..].starts_with(b"*/") { i+=1; } if i+1>=bytes.len() { return Err(Error::Invalid); } i+=2; clean[start..i].fill(b' '); continue; }
        let start=i; let kind=bytes[i]; i+=1;
        if kind==b'"' { while i<bytes.len() { if bytes[i]==b'\\' { i+=2; } else if bytes[i]==b'"' { i+=1; break; } else { i+=1; } } if i>bytes.len() || bytes.get(i-1)!=Some(&b'"') { return Err(Error::Invalid); } }
        else if !b"{}[]:,".contains(&kind) { while i<bytes.len() && !bytes[i].is_ascii_whitespace() && !b"{}[]:,/".contains(&bytes[i]) { i+=1; } }
        result.push(Token { start,end:i,kind });
    }
    for pair in result.windows(2) { if pair[0].kind==b',' && b"}]".contains(&pair[1].kind) { clean[pair[0].start]=b' '; } }
    Ok((result, clean))
}
/// Mirrors Web plugins.js: remove only non-NPM entries/commas, retaining unrelated JSONC bytes.
pub fn filter_plugins(source: &str) -> Result<String> {
    if source.len()>super::io::MAX_BYTES { return Err(Error::Invalid); }
    let (tokens, clean) = tokens(source)?;
    if tokens.is_empty() { return Ok(source.into()); }
    let root: Value = serde_json::from_slice(&clean).map_err(|_| Error::Invalid)?;
    if !root.is_object() { return Err(Error::Invalid); }
    let mut depth=0; let mut seen=std::collections::HashSet::new(); let mut edits=Vec::new(); let mut i=0;
    while i<tokens.len() {
        let token=&tokens[i];
        if depth==1 && token.kind==b'"' && tokens.get(i+1).is_some_and(|v| v.kind==b':') {
            let name: String=serde_json::from_str(&source[token.start..token.end]).map_err(|_| Error::Invalid)?;
            if name=="plugins" || name=="plugin" {
                if !seen.insert(name) || !tokens.get(i+2).is_some_and(|v| v.kind==b'[') { return Err(Error::Invalid); }
                let mut j=i+3; let mut level=0; let mut start=j; let mut entries=Vec::new();
                loop {
                    let next=tokens.get(j).ok_or(Error::Invalid)?;
                    if level==0 && (next.kind==b',' || next.kind==b']') {
                        if start<j { let first=&tokens[start]; let last=&tokens[j-1]; let value:Value=serde_json::from_slice(&clean[first.start..last.end]).map_err(|_| Error::Invalid)?;
                            entries.push((first.start,last.end,if next.kind==b',' {Some(next.start)} else {None},npm_plugin(&value))); }
                        if next.kind==b']' { break; } start=j+1;
                    } else if b"[{".contains(&next.kind) { level+=1; } else if b"]}".contains(&next.kind) { level-=1; }
                    j+=1;
                }
                let last_kept=entries.iter().rposition(|v|v.3);
                for (index,(start,end,comma,keep)) in entries.into_iter().enumerate() {
                    if !keep { edits.push((start,end)); }
                    if (!keep || last_kept.is_none_or(|last|index>=last)) && let Some(offset)=comma { edits.push((offset,offset+1)); }
                }
                i=j+1; continue;
            }
        }
        if b"[{".contains(&token.kind) { depth+=1; } else if b"]}".contains(&token.kind) { depth-=1; }
        i+=1;
    }
    edits.sort_unstable();
    let mut output=String::new(); let mut previous=0;
    for (start,end) in edits { output.push_str(&source[previous..start]); previous=end; }
    output.push_str(&source[previous..]); Ok(output)
}

pub use super::io::Entry as File;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction { Push, Pull }
/// One exact native grant for this SSH identity, not an active-host lookup. Reads fail closed.
pub trait Files: Send + Sync {
    fn read(&self, remote: bool) -> Result<Vec<File>>;
    /// Backup generation + CAS replacement of the exact preview; Unknown means do not replay.
    fn replace(&self, remote: bool, run: &str, before: &[File], after: &[File], cancel: &Cancellation) -> Result<()>;
    fn receipt(&self, remote: bool, run: &str) -> Result<Option<bool>>;
    fn history(&self, _remote: bool) -> Result<Vec<Value>> { Err(Error::Unavailable) }
}
#[derive(Clone, Copy)]
pub struct Selections { pub config:bool, pub single:[bool;2], pub directories:[bool;6], pub agents:bool, pub credentials:bool, pub magpie:bool }
impl Default for Selections {fn default()->Self{Self{config:true,single:[true;2],directories:[true;6],agents:true,credentials:false,magpie:false}}}
impl Selections {
    pub fn parse(value:&Value)->Result<Self>{
        exact(value,&["fileGroups","singleFiles","directories","agentsRoot","providerCredentials","magpie"])?;
        fn flags<const N:usize>(value:&Value)->Result<[bool;N]>{let array=value.as_array().filter(|v|v.len()==N).ok_or(Error::Invalid)?;let mut out=[false;N];for (index,v) in array.iter().enumerate(){out[index]=v.as_bool().ok_or(Error::Invalid)?;}Ok(out)}
        Ok(Self{config:flags::<1>(&value["fileGroups"])?[0],single:flags(&value["singleFiles"])?,directories:flags(&value["directories"])?,agents:value["agentsRoot"].as_bool().ok_or(Error::Invalid)?,credentials:value["providerCredentials"].as_bool().ok_or(Error::Invalid)?,magpie:value["magpie"].as_bool().ok_or(Error::Invalid)?})
    }
}
struct Plan { direction: Direction, before: Vec<File>, after: Vec<File>, phase: &'static str }
pub struct SyncOwner { files: Arc<dyn Files>, plans: Mutex<HashMap<String, Plan>> }
impl SyncOwner {
    pub fn new(files: Arc<dyn Files>) -> Self { Self { files, plans: Mutex::new(HashMap::new()) } }
    pub fn preview(&self, run: &str, direction: Direction) -> Result<Value> {
        self.preview_selected(run,direction,Selections::default())
    }
    pub fn preview_selected(&self, run: &str, direction: Direction, selections:Selections) -> Result<Value> {
        if !identifier(run) { return Err(Error::Invalid); }
        let mut plans=self.plans.lock().map_err(|_|Error::Unavailable)?;
        if plans.contains_key(run)||plans.len()>=32 { return Err(Error::Busy); }
        plans.insert(run.into(),Plan { direction,before:Vec::new(),after:Vec::new(),phase:"scanning" }); drop(plans);
        let result=(||{
            let source=self.files.read(direction==Direction::Pull)?;
            let before=self.files.read(direction==Direction::Push)?;
            validate_files(&source)?; validate_files(&before)?;
            let mut after=before.clone();let mut planned=Vec::new();let mut deletes=Vec::new();let mut directories=Vec::new();
            // Same mutually-exclusive precedence as Web constants.js.
            if selections.config {for name in super::io::CONFIG {
                if let Some(file)=source.iter().find(|v|v.name==name) { let text=std::str::from_utf8(&file.content).map_err(|_|Error::Invalid)?;let content=filter_plugins(text)?.into_bytes();after.retain(|v|!super::io::CONFIG.contains(&v.name.as_str()));after.push(File { name:file.name.clone(),content:content.clone(),version:file.version.clone(),mode:file.mode });planned.push(json!({"name":name,"bytes":content.len()}));deletes.extend(super::io::CONFIG.into_iter().filter(|v|*v!=name).map(str::to_owned));break; }
            }}
            for (index,name) in super::io::SINGLE.into_iter().enumerate(){if selections.single[index] && let Some(file)=source.iter().find(|v|v.name==name){after.retain(|v|v.name!=name);after.push(file.clone());planned.push(json!({"name":name,"bytes":file.content.len()}));}}
            for (index,(name,legacy)) in super::io::DIRECTORIES.into_iter().enumerate(){if selections.directories[index]&&source.iter().any(|v|v.name==format!("{name}/")){
                after.retain(|v|!under(&v.name,name)&&legacy.is_none_or(|old|!under(&v.name,old)));let files=source.iter().filter(|v|under(&v.name,name)).cloned().collect::<Vec<_>>();directories.push(json!({"name":name,"fileCount":files.iter().filter(|v|!v.directory()).count(),"bytes":files.iter().map(|v|v.content.len()).sum::<usize>()}));after.extend(files);deletes.push(name.into());if let Some(old)=legacy{deletes.push(old.into());}
            }}
            let agents=if selections.agents&&source.iter().any(|v|v.name=="@agents/"){after.retain(|v|!under(&v.name,"@agents"));let files=source.iter().filter(|v|under(&v.name,"@agents")).cloned().collect::<Vec<_>>();let metadata=json!({"fileCount":files.iter().filter(|v|!v.directory()).count(),"bytes":files.iter().map(|v|v.content.len()).sum::<usize>()});after.extend(files);Some(metadata)}else{None};
            if selections.credentials||selections.magpie {return Err(Error::Unavailable);}
            validate_files(&after)?;
            let public=json!({"runID":run,"phase":"review","direction":if direction==Direction::Push {"push"}else{"pull"},"files":planned,"directories":directories,"agentsRoot":agents,"deletes":deletes});
            let mut plans=self.plans.lock().map_err(|_|Error::Unavailable)?;
            plans.insert(run.into(),Plan {direction,before,after,phase:"review"}); Ok(public)
        })();
        if result.is_err() && let Ok(mut plans)=self.plans.lock(){plans.remove(run);}
        result
    }
    pub fn apply(&self, run: &str, cancel: &Cancellation) -> Result<Value> {
        cancel.check()?;
        let mut plans=self.plans.lock().map_err(|_|Error::Unavailable)?;
        if plans.values().any(|plan| matches!(plan.phase,"applying"|"unknown")) { return Err(Error::Busy); }
        let plan=plans.get_mut(run).ok_or(Error::Stale)?;
        if plan.phase!="review" { return Err(Error::Busy); }
        plan.phase="applying";
        let direction=plan.direction;
        let before=std::mem::take(&mut plan.before); let after=std::mem::take(&mut plan.after); drop(plans);
        let result=self.files.replace(direction==Direction::Push,run,&before,&after,cancel);
        let phase=match result {Ok(())=>"success",Err(Error::SyncUnknown|Error::CommitUnknown)=>"unknown",Err(_)=>"failure"};
        self.plans.lock().map_err(|_|Error::Unavailable)?.get_mut(run).ok_or(Error::Stale)?.phase=phase;
        result?; Ok(json!({"runID":run,"phase":phase}))
    }
    pub fn status(&self, run: &str) -> Result<Value> {
        let plans=self.plans.lock().map_err(|_|Error::Unavailable)?;
        let plan=plans.get(run).ok_or(Error::Stale)?;let phase=plan.phase;let remote=plan.direction==Direction::Push; drop(plans);
        let phase=if phase=="unknown" {match self.files.receipt(remote,run)?{Some(true)=>"success",Some(false)=>"failure",None=>"unknown"}}else{phase};
        if phase!="unknown" { self.plans.lock().map_err(|_|Error::Unavailable)?.get_mut(run).ok_or(Error::Stale)?.phase=phase; }
        Ok(json!({"runID":run,"phase":phase}))
    }
    pub fn history(&self,direction:Direction)->Result<Value>{Ok(json!({"direction":if direction==Direction::Push{"push"}else{"pull"},"runs":self.files.history(direction==Direction::Push)?}))}
}
fn validate_files(files: &[File]) -> Result<()> {
    super::io::validate(files)
}
fn under(path:&str,root:&str)->bool{path==root||path.strip_prefix(root).is_some_and(|rest|rest.starts_with('/'))}
