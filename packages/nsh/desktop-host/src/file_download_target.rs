//! The download's production adapter over the SAME documents Grant/Stage.
use super::{Commit, Result, Target, Targets, Verification, files};
use std::sync::Arc;
struct Destination {
    grant: files::Grant,
    stage: files::Stage,
}
pub(super) fn factory() -> Targets {
    Arc::new(|selected| {
        let grant = files::Grant::selected(selected)?;
        let stage = grant.begin()?;
        Ok(Box::new(Destination { grant, stage }))
    })
}
impl Target for Destination {
    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        self.stage.append(bytes)
    }
    fn rewind(&mut self, received: u64) -> Result<()> {
        self.stage.rewind(received)
    }
    fn seal(&mut self) -> Result<()> {
        self.stage.seal()
    }
    fn commit(&mut self) -> Commit {
        match self.grant.commit(&mut self.stage) {
            Ok(()) => Commit::Saved,
            Err(code) if code == "documents_write_unknown" => Commit::Unknown,
            Err(_) => Commit::Failed,
        }
    }
    fn inspect(&mut self, current: &dyn Fn() -> bool) -> Verification {
        if !current() {
            return Verification::Unconfirmed;
        }
        match self.grant.confirm_stage(&mut self.stage, current) {
            Ok(true) => Verification::Durable,
            _ if current() && self.grant.observes_stage(&self.stage).unwrap_or(false) => {
                Verification::Observed
            }
            _ => Verification::Unconfirmed,
        }
    }
}
