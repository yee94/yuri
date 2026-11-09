//! SSH native commands executed on the existing connection actor. Blocking OS
//! SSH work remains outside; authentication uses the actor's async Network jobs.
use super::connection_actor_storage::{self as storage, Binding, Credential};
use super::*;
use crate::connection_actor_port::{
    self as port, Call, Command, Committed, Current, Error, Registry, Secret, Target,
};

pub(super) fn error(e: &str) -> Error {
    if vault::invalidates_authority(e) {
        Error::CommitUnknown
    } else if e.contains("storage") || e.contains("secure_store") {
        Error::Storage
    } else if e.contains("stale") || e == "ssh_stale" {
        Error::Stale
    } else if e.contains("busy") || e.contains("capacity") {
        Error::Busy
    } else if e.contains("invalid") {
        Error::Invalid
    } else if e.contains("cancelled") {
        Error::Cancelled
    } else if e.contains("authorization") {
        Error::Authentication
    } else {
        Error::Unavailable
    }
}
enum Kind {
    Authorize {
        current: Current,
        call: Call<Committed>,
        mint: bool,
        port: u16,
        prior: Option<String>,
    },
    Restore {
        current: Current,
        call: Call<Option<Committed>>,
        binding: Binding,
    },
    Healthy {
        call: Call<bool>,
        binding: Binding,
    },
}
pub(super) struct Pending {
    target: Target,
    candidate: Connection,
    kind: Kind,
    selection: Option<port::SelectionProtection>,
}
impl Pending {
    pub fn scope_independent(&self) -> bool {
        // The selected Host/lease is not SSH's authority. Target CAS, exact
        // native binding and Cancellation fence each asynchronous continuation.
        true
    }
    pub fn valid(&self, actor: &Actor) -> bool {
        !actor.quarantined
            && !actor.native_poison.load(Ordering::Acquire)
            && actor
                .state
                .as_ref()
                .is_some_and(|s| s.native.instances.contains(&self.target))
            && match &self.kind {
                Kind::Authorize { current, .. } | Kind::Restore { current, .. } if !current() => {
                    false
                }
                Kind::Authorize { call, prior, .. } => call.current()
                    && actor.state().native.bindings.iter().rfind(|b| b.target == self.target)
                        .map(|b| &b.receipt) == prior.as_ref(),
                Kind::Restore { call, binding, .. } => {
                    call.current() && actor.binding_matches(binding)
                        && actor.state().native.bindings.iter().rfind(|b| b.target == self.target)
                            .is_some_and(|b| b.receipt == binding.receipt)
                }
                Kind::Healthy { call, binding } => {
                    call.current()
                        && actor.binding_matches(binding)
                        && actor.native_receipts.contains(&binding.receipt)
                }
            }
    }
    pub fn fail(self, error: Error) {
        match self.kind {
            Kind::Authorize { call, .. } => call.finish(Err(error)),
            Kind::Restore { call, .. } => call.finish(Err(error)),
            Kind::Healthy { call, .. } => call.finish(Err(error)),
        }
    }
}
impl Actor {
    fn native_protected(&self, id: &str, selection: &Option<port::SelectionProtection>) -> bool {
        selection.as_ref().is_none_or(|protect| protect(id))
    }
    pub(super) fn native_quarantine(&mut self) {
        self.quarantined = true;
        self.invalidate();
        self.native_receipts.clear();
        self.state = None;
    }
    fn native_admit<T>(&mut self, call: &Call<T>) -> port::Result<()> {
        call.begin()?;
        if self.native_poison.load(Ordering::Acquire) {
            self.native_quarantine();
            return Err(Error::CommitUnknown);
        }
        self.load().map_err(|e| error(&e))
    }
    fn native_target(&self, target: &Target) -> port::Result<()> {
        storage::target(&storage::target_value(target)).map_err(|_| Error::Invalid)?;
        if !self.state().native.instances.contains(target) {
            return Err(Error::Stale);
        }
        Ok(())
    }
    pub(super) fn binding_matches(&self, b: &Binding) -> bool {
        self.state.as_ref().is_some_and(|s| {
            s.native.bindings.iter().any(|v| {
                v.connection_id == b.connection_id
                    && v.authorization == b.authorization
                    && v.receipt == b.receipt
                    && v.target == b.target
            })
        })
    }
    pub(super) fn native_connection_live(&self, id: &str) -> bool {
        self.state.as_ref().is_some_and(|s| {
            s.native.binding(id).is_none_or(|b| {
                s.native.instances.contains(&b.target) && self.native_receipts.contains(&b.receipt)
                    && b.current.as_ref().is_none_or(|current| current())
            })
        })
    }
    pub(super) fn native_selected_live(&self, s: &State) -> bool {
        let retained = s.scope.is_some() && self.state.as_ref().is_some_and(|prior|
            prior.selected == s.selected && prior.scope == s.scope);
        s.selected.as_deref().is_none_or(|id| {
            s.native.binding(id).is_none_or(|b| {
                s.native.instances.contains(&b.target) && self.native_receipts.contains(&b.receipt)
                    && (retained || b.current.as_ref().is_some_and(|current| current()))
            })
        })
    }
    pub(super) fn native_command(&mut self, command: Command) {
        match command {
            Command::Load(call) => {
                let result = self.native_admit(&call).map(|_| Registry {
                    revision: self.state().native.revision,
                    instances: self.state().native.instances.clone(),
                });
                call.finish(result);
            }
            Command::Save {
                expected_revision,
                instances,
                call,
            } => {
                let result = (|| {
                    self.native_admit(&call)?;
                    if expected_revision != self.state().native.revision {
                        return Err(Error::Stale);
                    }
                    if expected_revision >= storage::MAX_REVISION || instances.len() > 32 {
                        return Err(Error::Busy);
                    }
                    for (i, t) in instances.iter().enumerate() {
                        storage::target(&storage::target_value(t)).map_err(|_| Error::Invalid)?;
                        if instances[..i].iter().any(|p| p.id == t.id) {
                            return Err(Error::Invalid);
                        }
                    }
                    let mut next = self.state().clone();
                    next.native.present = true;
                    next.native.revision += 1;
                    next.native.instances = instances;
                    next.native
                        .credentials
                        .retain(|c| next.native.instances.contains(&c.target));
                    let invalidates = !self.native_selected_live(&next);
                    if !call.current() {
                        return Err(Error::Cancelled);
                    }
                    let revision = next.native.revision;
                    self.commit(next, invalidates).map_err(|e| error(&e))?;
                    Ok(revision)
                })();
                call.finish(result);
            }
            Command::Password { target, call } => {
                let result = (|| {
                    self.native_admit(&call)?;
                    self.native_target(&target)?;
                    if let Some(c) = self
                        .state()
                        .native
                        .credentials
                        .iter()
                        .find(|c| c.target == target)
                    {
                        return Secret::new(c.password.clone());
                    }
                    if !target.managed {
                        return Err(Error::Authentication);
                    }
                    let password = format!(
                        "{}{}",
                        vault::id().map_err(|_| Error::Unavailable)?,
                        vault::id().map_err(|_| Error::Unavailable)?
                    );
                    let mut next = self.state().clone();
                    next.native.credentials.push(Credential {
                        target,
                        password: password.clone(),
                    });
                    if !call.current() {
                        return Err(Error::Cancelled);
                    }
                    self.commit(next, false).map_err(|e| error(&e))?;
                    Secret::new(password)
                })();
                call.finish(result);
            }
            Command::Authorize {
                target,
                local_port,
                password,
                current,
                selection,
                call,
            } => {
                let result = (|| {
                    self.native_admit(&call)?;
                    self.native_target(&target)?;
                    if !current() || !call.current() {
                        return Err(Error::Cancelled);
                    }
                    if local_port == 0
                        || !self
                            .state()
                            .native
                            .credentials
                            .iter()
                            .any(|c| c.target == target && c.password == password.expose())
                    {
                        return Err(Error::Authentication);
                    }
                    let prior = self
                        .state()
                        .native
                        .bindings
                        .iter()
                        .rfind(|b| b.target == target)
                        .map(|b| b.receipt.clone());
                    let candidate = Connection {
                        id: vault::id().map_err(|_| Error::Unavailable)?,
                        label: target.label.clone(),
                        url: format!("http://127.0.0.1:{local_port}"),
                        token: String::new(),
                        used: now(),
                        authorization: vault::id().map_err(|_| Error::Unavailable)?,
                        editor_version: Some(vault::id().map_err(|_| Error::Unavailable)?),
                    };
                    // Host dedupe replaces the prior client token. Background
                    // readiness must not revoke either a selected desktop token
                    // or a legacy untagged client with the same default label.
                    let body = json!({"password":password.expose(),"trustDevice":true,"issueClientToken":true,"clientKind":"desktop-local",
                        "dedupeKey":format!("desktop-local:ssh:{}", candidate.id),
                        "clientLabel":format!("Yuri SSH {}", candidate.id)});
                    let request =
                        make_request(&candidate, "/auth/session", "POST", Some(&body), true)
                            .map_err(|_| Error::Invalid)?;
                    Ok((candidate, request, prior))
                })();
                match result {
                    Ok((candidate, request, prior)) => self.start_job(
                        "/auth/session".into(),
                        request,
                        Completion::Native(Box::new(Pending {
                            target,
                            candidate,
                            selection,
                            kind: Kind::Authorize {
                                current,
                                call,
                                mint: true,
                                port: local_port,
                                prior,
                            },
                        })),
                        HostReply::default(),
                    ),
                    Err(e) => call.finish(Err(e)),
                }
            }
            Command::Restore {
                target,
                current,
                selection,
                call,
            } => {
                let result = (|| {
                    self.native_admit(&call)?;
                    self.native_target(&target)?;
                    if !current() || !call.current() {
                        return Err(Error::Cancelled);
                    }
                    let Some(binding) = self
                        .state()
                        .native
                        .bindings
                        .iter()
                        .rfind(|b| b.target == target)
                        .cloned()
                    else {
                        return Ok(None);
                    };
                    let mut candidate = self
                        .state()
                        .connections
                        .iter()
                        .find(|c| {
                            c.id == binding.connection_id
                                && c.authorization == binding.authorization
                        })
                        .cloned()
                        .ok_or(Error::Stale)?;
                    candidate.id = vault::id().map_err(|_| Error::Unavailable)?;
                    candidate.authorization = vault::id().map_err(|_| Error::Unavailable)?;
                    candidate.editor_version = Some(vault::id().map_err(|_| Error::Unavailable)?);
                    let request =
                        make_request(&candidate, "/api/config/settings", "GET", None, false)
                            .map_err(|_| Error::Invalid)?;
                    Ok(Some((binding, candidate, request)))
                })();
                match result {
                    Ok(Some((binding, candidate, request))) => self.start_job(
                        "/api/config/settings".into(),
                        request,
                        Completion::Native(Box::new(Pending {
                            target,
                            candidate,
                            selection,
                            kind: Kind::Restore {
                                current,
                                call,
                                binding,
                            },
                        })),
                        HostReply::default(),
                    ),
                    Ok(None) => call.finish(Ok(None)),
                    Err(e) => call.finish(Err(e)),
                }
            }
            Command::Healthy { committed, selection, call } => {
                let result = (|| {
                    self.native_admit(&call)?;
                    let Some(binding) = self
                        .state()
                        .native
                        .bindings
                        .iter()
                        .find(|b| {
                            b.connection_id == committed.connection_id
                                && b.receipt == committed.receipt
                                && self.native_receipts.contains(&b.receipt)
                                && self.state().native.instances.contains(&b.target)
                                && (self.native_protected(&b.connection_id, &selection)
                                    || b.current.as_ref().is_none_or(|current| current()))
                        })
                        .cloned()
                    else {
                        return Ok(None);
                    };
                    let candidate = self
                        .state()
                        .connections
                        .iter()
                        .find(|c| {
                            c.id == binding.connection_id
                                && c.authorization == binding.authorization
                        })
                        .cloned()
                        .ok_or(Error::Stale)?;
                    let request =
                        make_request(&candidate, "/api/config/settings", "GET", None, false)
                            .map_err(|_| Error::Invalid)?;
                    Ok(Some((binding, candidate, request)))
                })();
                match result {
                    Ok(Some((binding, candidate, request))) => self.start_job(
                        "/api/config/settings".into(),
                        request,
                        Completion::Native(Box::new(Pending {
                            target: binding.target.clone(),
                            candidate,
                            selection,
                            kind: Kind::Healthy { call, binding },
                        })),
                        HostReply::default(),
                    ),
                    Ok(None) => call.finish(Ok(false)),
                    Err(e) => call.finish(Err(e)),
                }
            }
            Command::Retire { committed, call } => {
                let result = self.native_admit(&call).map(|_| {
                    if self.state().native.bindings.iter().any(|b| {
                        b.connection_id == committed.connection_id && b.receipt == committed.receipt
                    }) {
                        self.native_receipts.remove(&committed.receipt);
                        if self.state().selected.as_deref() == Some(&committed.connection_id) {
                            self.invalidate();
                            self.state.as_mut().unwrap().scope = None;
                        }
                    }
                });
                self.retire_native_http_stale();
                call.finish(result);
            }
            Command::Quarantine(call) => {
                let result = call.begin().map(|_| self.native_quarantine());
                call.finish(result);
            }
        }
    }
    pub(super) fn native_finish(&mut self, mut pending: Pending, status: u16, body: Value) {
        if !pending.valid(self) {
            pending.fail(Error::Cancelled);
            return;
        }
        if matches!(&pending.kind, Kind::Healthy { .. }) {
            if let Kind::Healthy { call, .. } = pending.kind {
                call.finish(Ok(status == 200));
            }
            return;
        }
        if status != 200 {
            pending.fail(Error::Authentication);
            return;
        }
        if let Kind::Authorize { mint: true, .. } = &pending.kind {
            let token = policy::string(&body, "clientToken").and_then(|s| {
                policy::token(s)?;
                Ok(s.to_owned())
            });
            let Ok(token) = token else {
                pending.fail(Error::Authentication);
                return;
            };
            pending.candidate.token = token;
            if let Kind::Authorize { mint, .. } = &mut pending.kind {
                *mint = false;
            }
            match make_request(
                &pending.candidate,
                "/api/config/settings",
                "GET",
                None,
                false,
            ) {
                Ok(request) => self.start_job(
                    "/api/config/settings".into(),
                    request,
                    Completion::Native(Box::new(pending)),
                    HostReply::default(),
                ),
                Err(_) => pending.fail(Error::Authentication),
            }
            return;
        }
        let result = (|| {
            let receipt = vault::id().map_err(|_| Error::Unavailable)?;
            if self.state().connections.iter().any(|c| c.id == pending.candidate.id)
                || self.state().native.bindings.iter().any(|b| b.receipt == receipt)
                || self.native_receipts.contains(&receipt) {
                return Err(Error::Stale);
            }
            let local_port = match &pending.kind {
                Kind::Authorize { port, .. } => *port,
                Kind::Restore { binding, .. } => binding.local_port,
                _ => unreachable!(),
            };
            let binding = Binding {
                target: pending.target.clone(),
                connection_id: pending.candidate.id.clone(),
                authorization: pending.candidate.authorization.clone(),
                receipt: receipt.clone(),
                local_port,
                current: match &pending.kind {
                    Kind::Authorize { current, .. } | Kind::Restore { current, .. } => Some(current.clone()),
                    _ => unreachable!(),
                },
            };
            let mut next = self.state().clone();
            // IDs are immutable readiness versions. Never overwrite an active Host's
            // endpoint/auth, even when a reconnect targets that very same SSH row.
            let obsolete: std::collections::HashSet<_> = next.native.bindings.iter()
                .filter(|b| b.target == pending.target && !self.native_protected(&b.connection_id, &pending.selection))
                .map(|b| b.connection_id.clone()).collect();
            next.connections.retain(|c| !obsolete.contains(&c.id));
            next.native.bindings.retain(|b| !obsolete.contains(&b.connection_id));
            if next.connections.len() >= 32 {
                return Err(Error::Busy);
            }
            next.connections.push(pending.candidate.clone());
            next.native
                .bindings
                .retain(|b| b.connection_id != binding.connection_id);
            next.native.bindings.push(binding);
            if !pending.valid(self) {
                return Err(Error::Cancelled);
            }
            self.native_receipts.insert(receipt.clone());
            if let Err(e) = self.commit(next, false) {
                self.native_receipts.remove(&receipt);
                return Err(error(&e));
            }
            Ok(Committed {
                connection_id: pending.candidate.id.clone(),
                receipt,
            })
        })();
        match pending.kind {
            Kind::Authorize { call, .. } => call.finish(result),
            Kind::Restore { call, .. } => call.finish(result.map(Some)),
            _ => unreachable!(),
        }
    }
}
