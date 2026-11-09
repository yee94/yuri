use super::*;

pub const PROGRAM: &str = include_str!("ssh_io_remote.cjs");
pub trait ProgramTransport: Send + Sync {
    /// Only fixed PROGRAM may execute. The request is native JSON/bytes, never JS origin or shell.
    fn exchange(
        &self,
        instance: &Instance,
        request: &Value,
        cancel: &Cancellation,
    ) -> Result<Value>;
}
pub struct Remote {
    instance: Instance,
    identity: String,
    transport: Arc<dyn ProgramTransport>,
}
impl Remote {
    pub fn new(
        instance: Instance,
        identity: String,
        transport: Arc<dyn ProgramTransport>,
    ) -> Result<Self> {
        Instance::parse(&instance.public())?;
        if !identifier(&identity) {
            return Err(Error::Invalid);
        }
        Ok(Self {
            instance,
            identity,
            transport,
        })
    }
    fn request(
        &self,
        op: &str,
        run: Option<&str>,
        before: &[Entry],
        after: &[Entry],
        cancel: &Cancellation,
    ) -> Result<Value> {
        if run.is_some_and(|v| !identifier(v)) {
            return Err(Error::Invalid);
        }
        let request = json!({"schema":1,"op":op,"identity":self.identity,"runID":run,"before":before.iter().map(|v|v.wire(true)).collect::<Vec<_>>(),"after":after.iter().map(|v|v.wire(true)).collect::<Vec<_>>()});
        let response = self
            .transport
            .exchange(&self.instance, &request, cancel)
            .map_err(|e| if op == "apply" { Error::SyncUnknown } else { e })?;
        if response["ok"] != true {
            if op == "apply" && !matches!(response["phase"].as_str(), Some("denied" | "failure")) {
                return Err(Error::SyncUnknown);
            }
            return Err(match response["error"].as_str() {
                Some("ssh_invalid") => Error::Invalid,
                Some("ssh_stale") => Error::Stale,
                Some("ssh_busy") => Error::Busy,
                Some("ssh_sync_unknown") => Error::SyncUnknown,
                _ => Error::Storage,
            });
        }
        Ok(response)
    }
}
impl Endpoint for Remote {
    fn read(&self, cancel: &Cancellation) -> Result<Vec<Entry>> {
        let value = self.request("read", None, &[], &[], cancel)?;
        let entries = value["entries"]
            .as_array()
            .ok_or(Error::Invalid)?
            .iter()
            .map(Entry::parse)
            .collect::<Result<Vec<_>>>()?;
        validate(&entries)?;
        Ok(entries)
    }
    fn replace(
        &self,
        run: &str,
        before: &[Entry],
        after: &[Entry],
        cancel: &Cancellation,
    ) -> Result<()> {
        validate(before)?;
        validate(after)?;
        cancel.check()?;
        let response = self.request("apply", Some(run), before, after, cancel)?;
        if response["runID"] != run || response["phase"] != "success" {
            return Err(Error::SyncUnknown);
        }
        Ok(())
    }
    fn receipt(&self, run: &str) -> Result<Option<bool>> {
        let response = self.request("status", Some(run), &[], &[], &Cancellation::default())?;
        if response["runID"] != run {
            return Err(Error::Invalid);
        }
        match response["phase"].as_str() {
            Some("success") => Ok(Some(true)),
            Some("failure") => Ok(Some(false)),
            Some("unknown") => Ok(None),
            _ => Err(Error::Invalid),
        }
    }
    fn history(&self) -> Result<Vec<Value>> {
        let response = self.request("history", None, &[], &[], &Cancellation::default())?;
        let runs = response["runs"]
            .as_array()
            .filter(|v| v.len() <= 4096)
            .ok_or(Error::Invalid)?;
        let mut seen = HashSet::new();
        for run in runs {
            exact(
                run,
                &[
                    "schema",
                    "runID",
                    "phase",
                    "startedAt",
                    "endedAt",
                    "files",
                    "bytes",
                    "applied",
                ],
            )?;
            let id = text(run, "runID", 128)?;
            let timestamp = |v: &Value| {
                v.as_str().is_some_and(|v| {
                    (20..=39).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit())
                })
            };
            if !identifier(&id)
                || !seen.insert(id)
                || run["schema"] != 1
                || !matches!(
                    run["phase"].as_str(),
                    Some("prepared" | "applying" | "unknown" | "success" | "failure")
                )
                || !timestamp(&run["startedAt"])
                || (!run["endedAt"].is_null() && !timestamp(&run["endedAt"]))
                || !run["files"].as_u64().is_some_and(|v| v <= MAX_FILES as u64)
                || !run["bytes"].as_u64().is_some_and(|v| v <= MAX_BYTES as u64)
                || !run["applied"]
                    .as_u64()
                    .is_some_and(|v| v <= 2 * MAX_FILES as u64)
            {
                return Err(Error::Invalid);
            }
        }
        Ok(runs.clone())
    }
}
