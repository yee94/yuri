//! Native SSH metadata inside the ORIGINAL connection Vault record, never a second Store.
use super::*;
use crate::connection_actor_port::{Secret, Target};
pub(super) const MAX_REVISION: u64 = 9_007_199_254_740_000;
#[derive(Clone)]
pub(super) struct Credential {
    pub target: Target,
    pub password: String,
}
#[derive(Clone)]
pub(super) struct Binding {
    pub target: Target,
    pub connection_id: String,
    pub authorization: String,
    pub receipt: String,
    pub local_port: u16,
    // Only the original actor retains the live cancellation fence; never serialized.
    pub current: Option<crate::connection_actor_port::Current>,
}
#[derive(Clone, Default)]
pub(super) struct Native {
    pub present: bool,
    pub revision: u64,
    pub instances: Vec<Target>,
    pub credentials: Vec<Credential>,
    pub bindings: Vec<Binding>,
}
pub(super) fn target_value(t: &Target) -> Value {
    json!({"id":t.id,"label":t.label,"host":t.host,"user":t.user,"port":t.port,"remotePort":t.remote_port,"localPort":t.local_port,"managed":t.managed})
}
pub(super) fn target(v: &Value) -> Result<Target> {
    policy::keys(
        v,
        &[
            "id",
            "label",
            "host",
            "user",
            "port",
            "remotePort",
            "localPort",
            "managed",
        ],
        &[
            "id",
            "label",
            "host",
            "user",
            "port",
            "remotePort",
            "localPort",
            "managed",
        ],
    )?;
    let text = |k: &str, max| -> Result<String> {
        let s = policy::string(v, k)?;
        if s.len() > max || s.chars().any(char::is_control) {
            return Err("ssh_invalid".into());
        }
        Ok(s.into())
    };
    let port = |k: &str, zero| {
        v[k].as_u64()
            .filter(|n| *n <= 65535 && (zero || *n > 0))
            .map(|n| n as u16)
            .ok_or_else(|| "ssh_invalid".to_owned())
    };
    let t = Target {
        id: text("id", 128)?,
        label: text("label", 240)?,
        host: text("host", 253)?,
        user: text("user", 64)?,
        port: port("port", false)?,
        remote_port: port("remotePort", false)?,
        local_port: port("localPort", true)?,
        managed: v["managed"].as_bool().ok_or("ssh_invalid")?,
    };
    if !identifier(&t.id)
        || !t.host.as_bytes()[0].is_ascii_alphanumeric()
        || !t
            .host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        || t.user.starts_with('-')
        || !t
            .user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("ssh_invalid".into());
    }
    Ok(t)
}
pub(super) fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn rows(v: &Value) -> Result<&Vec<Value>> {
    v.as_array()
        .filter(|v| v.len() <= 32)
        .ok_or_else(|| "secure_store_invalid".into())
}
impl Native {
    /// Restore only native in-memory cancellation fences after a shared-lane
    /// reload. This never issues receipts or imports authentication material.
    pub fn inherit_live(&mut self, previous: &Self) {
        for binding in &mut self.bindings {
            if let Some(prior) = previous.bindings.iter().find(|prior|
                prior.target == binding.target && prior.connection_id == binding.connection_id
                    && prior.authorization == binding.authorization && prior.receipt == binding.receipt
                    && prior.local_port == binding.local_port)
                && let Some(incoming) = &prior.current {
                    if let Some(current) = &binding.current {
                        if !current() || Arc::ptr_eq(current, incoming) { continue; }
                        // One receipt has one Cancellation identity. Conflicting
                        // in-memory evidence is denied, never a fresh true grant.
                        binding.current = Some(Arc::new(|| false));
                    } else {
                        binding.current = Some(incoming.clone());
                    }
            }
        }
    }
    pub fn read(root: &Value) -> Result<Self> {
        let mut n = Self::default();
        if let Some(v) = root.get("sshRegistry") {
            policy::keys(
                v,
                &["schema", "revision", "instances"],
                &["schema", "revision", "instances"],
            )?;
            if v["schema"] != 1 {
                return Err("secure_store_invalid".into());
            }
            n.present = true;
            n.revision = v["revision"]
                .as_u64()
                .filter(|v| *v <= MAX_REVISION)
                .ok_or("secure_store_invalid")?;
            n.instances = rows(&v["instances"])?
                .iter()
                .map(target)
                .collect::<Result<_>>()?;
            for (i, t) in n.instances.iter().enumerate() {
                if n.instances[..i].iter().any(|p| p.id == t.id) {
                    return Err("secure_store_invalid".into());
                }
            }
        }
        if let Some(v) = root.get("sshNative") {
            policy::keys(
                v,
                &["schema", "credentials", "bindings"],
                &["schema", "credentials", "bindings"],
            )?;
            if v["schema"] != 1 {
                return Err("secure_store_invalid".into());
            }
            for row in rows(&v["credentials"])? {
                policy::keys(row, &["target", "password"], &["target", "password"])?;
                let t = target(&row["target"])?;
                let password = policy::string(row, "password")?;
                Secret::new(password.into()).map_err(|_| "secure_store_invalid")?;
                if !n.instances.contains(&t) || n.credentials.iter().any(|c| c.target.id == t.id) {
                    return Err("secure_store_invalid".into());
                }
                n.credentials.push(Credential {
                    target: t,
                    password: password.into(),
                });
            }
            for row in rows(&v["bindings"])? {
                policy::keys(
                    row,
                    &[
                        "target",
                        "connectionID",
                        "authorizationID",
                        "receipt",
                        "localPort",
                    ],
                    &[
                        "target",
                        "connectionID",
                        "authorizationID",
                        "receipt",
                        "localPort",
                    ],
                )?;
                let t = target(&row["target"])?;
                let id = |k: &str| -> Result<String> {
                    let s = policy::string(row, k)?;
                    if !identifier(s) {
                        return Err("secure_store_invalid".into());
                    }
                    Ok(s.into())
                };
                let b = Binding {
                    target: t,
                    connection_id: id("connectionID")?,
                    authorization: id("authorizationID")?,
                    receipt: id("receipt")?,
                    local_port: row["localPort"]
                        .as_u64()
                        .filter(|p| *p > 0 && *p <= 65535)
                        .ok_or("secure_store_invalid")? as u16,
                    current: None,
                };
                if n.bindings.iter().any(|p| {
                    p.receipt == b.receipt
                        || p.connection_id == b.connection_id
                }) {
                    return Err("secure_store_invalid".into());
                }
                n.bindings.push(b);
            }
        }
        Ok(n)
    }
    pub fn write(&self, root: &mut Value) {
        if self.present {
            root["sshRegistry"] = json!({"schema":1,"revision":self.revision,"instances":self.instances.iter().map(target_value).collect::<Vec<_>>()});
        }
        if !self.credentials.is_empty() || !self.bindings.is_empty() {
            root["sshNative"] = json!({"schema":1,"credentials":self.credentials.iter().map(|c|json!({"target":target_value(&c.target),"password":c.password})).collect::<Vec<_>>(),"bindings":self.bindings.iter().map(|b|json!({"target":target_value(&b.target),"connectionID":b.connection_id,"authorizationID":b.authorization,"receipt":b.receipt,"localPort":b.local_port})).collect::<Vec<_>>()});
        }
    }
    pub fn binding(&self, id: &str) -> Option<&Binding> {
        self.bindings.iter().find(|b| b.connection_id == id)
    }
    pub fn check(&self, connections: &[Connection]) -> Result<()> {
        for b in &self.bindings {
            if !connections.iter().any(|c| {
                c.id == b.connection_id
                    && c.authorization == b.authorization
                    && !c.token.is_empty()
                    && c.url == format!("http://127.0.0.1:{}", b.local_port)
            }) {
                return Err("secure_store_invalid".into());
            }
        }
        Ok(())
    }
    pub fn prune(&mut self, connections: &[Connection]) {
        self.bindings.retain(|b| {
            connections
                .iter()
                .any(|c| c.id == b.connection_id && c.authorization == b.authorization)
        });
    }
}
