//! Test-only sensitive sync adapter. The original actor owns all HTTP authority;
//! this layer only moves private bytes and validates bounded public metadata.
use super::{Cancellation, SyncGrant, identifier};
use crate::{connection_actor_http_port as native, connection_actor_port as actor};
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU8, Ordering},
};

const METADATA_LIMIT: usize = 1024 * 1024;
pub type Result<T> = native::Result<T>;
pub use native::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Credentials,
    Magpie,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Inventory {
    Credentials { bytes: Option<usize> },
    Magpie { available: bool, installed: bool },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Warning {
    SignInRequired,
    PluginInstallFailed,
    AgentSettingsSkipped,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Ack {
    pub warnings: Vec<Warning>,
}

/// No Debug, Clone, Serialize, or public byte accessor. Only native export creates
/// this value; import consumes it without exposing it to previews or run records.
pub struct Transfer {
    kind: Kind,
    bytes: Vec<u8>,
}
enum Endpoint {
    Remote(actor::Committed),
    Local,
}
pub struct Adapter {
    port: native::Port,
    endpoint: Endpoint,
    cancel: Cancellation,
    authority_retired: AtomicBool,
    // 0 = idle, 1 = one import in progress, 2 = unknown; reads remain possible.
    write: AtomicU8,
}
impl Adapter {
    pub fn remote(port: native::Port, grant: SyncGrant) -> Result<Self> {
        if !identifier(&grant.committed.connection_id)
            || grant.committed.receipt.is_empty()
            || grant.committed.receipt.len() > 4096
        {
            return Err(Error::Invalid);
        }
        Ok(Self::new(
            port,
            Endpoint::Remote(actor::Committed {
                connection_id: grant.committed.connection_id,
                receipt: grant.committed.receipt,
            }),
            grant.cancel,
        ))
    }
    /// Currently Unavailable. Only the original actor may issue this grant; the
    /// active Host, SSH endpoint, or a guessed localhost can never replace it.
    pub fn local(port: native::Port, cancel: Cancellation) -> Result<Self> {
        port.local_service()?;
        Ok(Self::new(port, Endpoint::Local, cancel))
    }
    fn new(port: native::Port, endpoint: Endpoint, cancel: Cancellation) -> Self {
        Self {
            port,
            endpoint,
            cancel,
            authority_retired: AtomicBool::new(false),
            write: AtomicU8::new(0),
        }
    }
    fn current(&self, cancel: &Cancellation) -> actor::Current {
        let cancel = self.cancel.linked(cancel);
        Arc::new(move || cancel.check().is_ok())
    }
    fn request(&self, request: native::Request, cancel: &Cancellation) -> Result<native::Response> {
        if self.authority_retired.load(Ordering::Acquire) {
            return Err(Error::CommitUnknown);
        }
        let authority = match &self.endpoint {
            Endpoint::Remote(receipt) => native::Authority::Remote(actor::Committed {
                connection_id: receipt.connection_id.clone(),
                receipt: receipt.receipt.clone(),
            }),
            Endpoint::Local => native::Authority::Local(self.port.local_service()?),
        };
        self.port
            .request(authority, request, self.current(cancel))
            .inspect_err(|error| {
                if *error == Error::CommitUnknown {
                    self.authority_retired.store(true, Ordering::Release);
                }
            })
    }
    pub fn inventory(&self, kind: Kind, cancel: &Cancellation) -> Result<Inventory> {
        let request = match kind {
            Kind::Credentials => native::Request::CredentialsInventory,
            Kind::Magpie => native::Request::MagpieInventory,
        };
        let value = metadata(self.request(request, cancel)?)?;
        match kind {
            Kind::Credentials => {
                fields(&value, &["providerCredentials"])?;
                let item = &value["providerCredentials"];
                let bytes = if item.is_null() {
                    None
                } else {
                    fields(item, &["bytes"])?;
                    Some(
                        item["bytes"]
                            .as_u64()
                            .filter(|n| *n > 0 && *n <= native::MAX_BYTES as u64)
                            .ok_or(Error::Invalid)? as usize,
                    )
                };
                Ok(Inventory::Credentials { bytes })
            }
            Kind::Magpie => {
                fields(&value, &["magpie"])?;
                fields(&value["magpie"], &["available", "installed"])?;
                let available = value["magpie"]["available"]
                    .as_bool()
                    .ok_or(Error::Invalid)?;
                let installed = value["magpie"]["installed"]
                    .as_bool()
                    .ok_or(Error::Invalid)?;
                if available && !installed {
                    return Err(Error::Invalid);
                }
                Ok(Inventory::Magpie {
                    available,
                    installed,
                })
            }
        }
    }
    pub fn export(&self, kind: Kind, cancel: &Cancellation) -> Result<Transfer> {
        let request = match kind {
            Kind::Credentials => native::Request::CredentialsExport,
            Kind::Magpie => native::Request::MagpieExport,
        };
        let response = self.request(request, cancel)?;
        if !(200..300).contains(&response.status) {
            return Err(Error::Unavailable);
        }
        if response.body.is_empty() || response.body.len() > native::MAX_BYTES {
            return Err(Error::Invalid);
        }
        Ok(Transfer {
            kind,
            bytes: response.body,
        })
    }
    /// No retry, quarantine, or success inference from a later inventory. An
    /// unknown write fences all further imports on this adapter, not the Vault.
    pub fn import(&self, transfer: Transfer, cancel: &Cancellation) -> Result<Ack> {
        if self.authority_retired.load(Ordering::Acquire) {
            return Err(Error::CommitUnknown);
        }
        self.write
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|state| {
                if state == 2 {
                    Error::Unknown
                } else {
                    Error::Busy
                }
            })?;
        let kind = transfer.kind;
        let request = match kind {
            Kind::Credentials => native::Request::CredentialsImport(transfer.bytes),
            Kind::Magpie => native::Request::MagpieImport(transfer.bytes),
        };
        let result = self
            .request(request, cancel)
            .and_then(|response| ack(response, kind));
        self.write.store(
            if matches!(result, Err(Error::Unknown)) {
                2
            } else {
                0
            },
            Ordering::Release,
        );
        result
    }
}
fn fields(value: &Value, keys: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or(Error::Invalid)?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn metadata(response: native::Response) -> Result<Value> {
    if !(200..300).contains(&response.status) {
        return Err(Error::Unavailable);
    }
    if response.body.len() > METADATA_LIMIT {
        return Err(Error::Invalid);
    }
    serde_json::from_slice(&response.body).map_err(|_| Error::Invalid)
}
fn ack(response: native::Response, kind: Kind) -> Result<Ack> {
    let value = metadata(response).map_err(|_| Error::Unknown)?;
    let keys = if kind == Kind::Magpie && value.get("magpieWarnings").is_some() {
        &["ok", "magpieWarnings"][..]
    } else {
        &["ok"][..]
    };
    fields(&value, keys).map_err(|_| Error::Unknown)?;
    if value["ok"] != true {
        return Err(Error::Unknown);
    }
    let mut warnings = Vec::new();
    if let Some(items) = value.get("magpieWarnings") {
        for item in items
            .as_array()
            .filter(|items| items.len() <= 3)
            .ok_or(Error::Unknown)?
        {
            let warning = match item.as_str() {
                Some("sign_in_required") => Warning::SignInRequired,
                Some("plugin_install_failed") => Warning::PluginInstallFailed,
                Some("agent_settings_skipped") => Warning::AgentSettingsSkipped,
                _ => return Err(Error::Unknown),
            };
            if warnings.contains(&warning) {
                return Err(Error::Unknown);
            }
            warnings.push(warning);
        }
    }
    Ok(Ack { warnings })
}

#[cfg(test)]
#[path = "ssh_http_tests.rs"]
mod tests;
