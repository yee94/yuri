//! Process-local execution permits backed by the ORIGINAL secure transaction lane.
//! Durable held grants survive crashes as unresolved; no TTL, forced unlock or replay.
use super::*;
use std::sync::Mutex;

pub const METHODS: &[&str] = &[
    "desktop.writer.capabilities",
    "desktop.writer.acquire",
    "desktop.writer.release",
    "desktop.writer.renew",
];
const FIELD: &str = "nativeWindowWriters";
const MAX: usize = 64;
#[derive(Default)]
pub(super) struct Book {
    active: HashMap<String, Active>,
}
struct Active {
    authority: Value,
    window: String,
    owner: String,
    scope: Value,
    pending: usize,
    unknown: bool,
}
#[derive(Clone)]
pub(super) struct Port {
    book: Arc<Mutex<Book>>,
    window: String,
    key: String,
}
impl Port {
    pub(super) fn can_close(&self) -> bool {
        self.book.lock().is_ok_and(|book| {
            book.active
                .values()
                .filter(|active| active.window == self.window)
                .all(|active| active.pending == 0 && !active.unknown)
        })
    }
    pub(super) fn new(
        book: Arc<Mutex<Book>>,
        services: &host_services::Port,
        key: String,
    ) -> Result<Self> {
        Ok(Self {
            book,
            window: services.window_id()?,
            key,
        })
    }
    pub(super) fn retire(&self) {
        if let Ok(mut book) = self.book.lock() {
            for grant in book
                .active
                .values_mut()
                .filter(|grant| grant.window == self.window)
            {
                grant.unknown = true;
            }
        }
    }
    fn call(&self, actor: &mut Actor, name: &str, input: &Value) -> Result<Value> {
        if !actor.services.live() {
            return Err("writer_unavailable".into());
        }
        if name == METHODS[0] {
            policy::keys(input, &[], &[])?;
            return Ok(
                json!({"schemaVersion":1,"supported":true,"acquire":true,"release":true,"renew":true,"recovery":false,"requiresExpectedHost":true,"windowID":self.window,"maxWriters":MAX}),
            );
        }
        let fields: &[&str] = if name == METHODS[1] {
            &["ownerID", "target", "expectedHost"]
        } else {
            &["ownerID", "target", "expectedHost", "grantID"]
        };
        policy::keys(input, fields, fields)?;
        actor.load()?;
        let scope = actor.state().admit(input.get("expectedHost"), true)?;
        let owner = identity(input, "ownerID", 128)?;
        let target = target(&input["target"])?;
        let host = policy::string(&scope, "hostID")?;
        let committed = actor.state().current()?;
        let authority = json!({"origin":committed.url,"authorizationID":committed.authorization});
        let mut saved = records(actor.state())?;
        let index = saved
            .iter()
            .position(|row| row["hostID"] == host && row["target"] == target);
        let book = self.book.lock().map_err(|_| "writer_unavailable")?;
        if name == METHODS[1] {
            if let Some(index) = index {
                let id = policy::string(&saved[index], "grantID")?;
                let active = book.active.get(id).ok_or("writer_recovery_required")?;
                if active.unknown {
                    return Err("writer_unknown".into());
                }
                if active.window != self.window || active.owner != owner {
                    return Err("writer_conflict".into());
                }
                if active.scope != scope {
                    return Err("writer_scope_stale".into());
                }
                if active.authority != authority
                    || saved[index].get("authority") != Some(&authority)
                {
                    return Err("writer_authority_changed".into());
                }
                return Ok(
                    json!({"schemaVersion":1,"grantID":id,"windowID":self.window,"ownerID":owner,"target":target,"expectedHost":scope}),
                );
            }
            if saved.len() >= MAX || book.active.len() >= MAX {
                return Err("writer_capacity".into());
            }
            let id = vault::id()?;
            saved.push(json!({"hostID":host,"target":target,"windowKey":self.key,"grantID":id,"authority":authority}));
            drop(book);
            persist(actor, saved)?;
            let mut book = self.book.lock().map_err(|_| "writer_unavailable")?;
            book.active.insert(
                id.clone(),
                Active {
                    authority,
                    window: self.window.clone(),
                    owner: owner.into(),
                    scope: scope.clone(),
                    pending: 0,
                    unknown: false,
                },
            );
            Ok(
                json!({"schemaVersion":1,"grantID":id,"windowID":self.window,"ownerID":owner,"target":target,"expectedHost":scope}),
            )
        } else if name == METHODS[2] || name == METHODS[3] {
            let id = identity(input, "grantID", 128)?;
            let index = index
                .filter(|index| saved[*index]["grantID"] == id)
                .ok_or("writer_grant_stale")?;
            let active = book.active.get(id).ok_or("writer_recovery_required")?;
            if active.window != self.window || active.owner != owner {
                return Err("writer_grant_stale".into());
            }
            if active.unknown {
                return Err("writer_unknown".into());
            }
            if active.pending != 0 {
                return Err("writer_pending".into());
            }
            if active.authority != authority || saved[index].get("authority") != Some(&authority) {
                return Err("writer_authority_changed".into());
            }
            if name == METHODS[3] {
                if active.scope == scope {
                    return Ok(
                        json!({"schemaVersion":1,"grantID":id,"windowID":self.window,"ownerID":owner,"target":target,"expectedHost":scope}),
                    );
                }
                let renewed = vault::id()?;
                saved[index]["grantID"] = json!(renewed);
                drop(book);
                persist(actor, saved)?;
                let mut book = self.book.lock().map_err(|_| "writer_unavailable")?;
                book.active.remove(id);
                book.active.insert(
                    renewed.clone(),
                    Active {
                        authority,
                        window: self.window.clone(),
                        owner: owner.into(),
                        scope: scope.clone(),
                        pending: 0,
                        unknown: false,
                    },
                );
                return Ok(
                    json!({"schemaVersion":1,"grantID":renewed,"windowID":self.window,"ownerID":owner,"target":target,"expectedHost":scope}),
                );
            }
            if active.scope != scope {
                return Err("writer_scope_stale".into());
            }
            saved.remove(index);
            drop(book);
            persist(actor, saved)?;
            let mut book = self.book.lock().map_err(|_| "writer_unavailable")?;
            book.active.remove(id);
            Ok(json!({"released":true,"grantID":id}))
        } else {
            Err("writer_unsupported".into())
        }
    }
    pub(super) fn final_close(&self, actor: &mut Actor) -> Result<()> {
        let book = self.book.lock().map_err(|_| "writer_unavailable")?;
        let owned: Vec<_> = book
            .active
            .iter()
            .filter(|(_, active)| active.window == self.window)
            .collect();
        if owned
            .iter()
            .any(|(_, active)| active.pending != 0 || active.unknown)
        {
            return Err("writer_close_unresolved".into());
        }
        let ids: Vec<_> = owned.into_iter().map(|(id, _)| id.clone()).collect();
        drop(book);
        if ids.is_empty() {
            return Ok(());
        }
        actor.load()?;
        let mut saved = records(actor.state())?;
        let before = saved.len();
        saved.retain(|row| !ids.iter().any(|id| row["grantID"] == *id));
        if before - saved.len() != ids.len() {
            return Err("writer_store_invalid".into());
        }
        persist(actor, saved)?;
        let mut book = self.book.lock().map_err(|_| "writer_unavailable")?;
        for id in ids {
            book.active.remove(&id);
        }
        Ok(())
    }
    pub(super) fn admit(
        &self,
        actor: &Actor,
        path: &str,
        request: &HttpRequest,
        grant: Option<&str>,
    ) -> Result<Option<Guard>> {
        let candidate = if path.split('?').next() == Some("/api/session") && request.method != "GET"
        {
            if request.method != "POST" {
                return Err("writer_target_unavailable".into());
            }
            let nsh_core::platform::HttpBody::Bytes(bytes) = &request.body else {
                return Err("writer_target_unavailable".into());
            };
            let body: Value = serde_json::from_slice(bytes).map_err(|_| "writer_target_invalid")?;
            let directory = policy::string(&body["location"], "directory")?;
            Some(target(&json!({"kind":"new-session","id":directory}))?)
        } else {
            route_target(path, &request.method)?
        };
        let Some(target) = candidate else {
            return Ok(None);
        };
        let scope = actor.state().admit(actor.state().scope.as_ref(), true)?;
        let saved = records(actor.state())?;
        let row = saved
            .iter()
            .find(|row| row["hostID"] == scope["hostID"] && row["target"] == target)
            .ok_or("writer_required")?;
        let id = policy::string(row, "grantID")?;
        if grant != Some(id) {
            return Err("writer_grant_required".into());
        }
        let mut book = self.book.lock().map_err(|_| "writer_unavailable")?;
        let active = book.active.get_mut(id).ok_or("writer_recovery_required")?;
        if active.window != self.window || active.scope != scope {
            return Err("writer_not_owner".into());
        }
        if active.unknown {
            return Err("writer_unknown".into());
        }
        let committed = actor.state().current()?;
        let authority = json!({"origin":committed.url,"authorizationID":committed.authorization});
        if active.authority != authority || row.get("authority") != Some(&authority) {
            return Err("writer_authority_changed".into());
        }
        active.pending = active.pending.checked_add(1).ok_or("writer_capacity")?;
        Ok(Some(Guard {
            book: self.book.clone(),
            id: id.into(),
            complete: false,
        }))
    }
}
pub(super) fn grant(input: &Value) -> Result<Option<String>> {
    input
        .get("writerGrant")
        .map(|_| identity(input, "writerGrant", 128).map(str::to_owned))
        .transpose()
}
pub(super) struct Guard {
    book: Arc<Mutex<Book>>,
    id: String,
    complete: bool,
}
impl Guard {
    pub(super) fn complete(&mut self) {
        self.complete = true;
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if let Ok(mut book) = self.book.lock()
            && let Some(active) = book.active.get_mut(&self.id)
        {
            active.pending = active.pending.saturating_sub(1);
            if !self.complete {
                active.unknown = true;
            }
        }
    }
}
fn identity<'a>(value: &'a Value, field: &str, max: usize) -> Result<&'a str> {
    policy::string(value, field).and_then(|id| {
        if id.len() <= max && !id.chars().any(char::is_control) {
            Ok(id)
        } else {
            Err("writer_identity_invalid".into())
        }
    })
}
fn target(value: &Value) -> Result<Value> {
    policy::keys(value, &["kind", "id"], &["kind", "id"])?;
    if !matches!(
        value["kind"].as_str(),
        Some("session" | "assistant" | "new-session")
    ) {
        return Err("writer_target_invalid".into());
    }
    let id = identity(value, "id", 1024)?;
    if value["kind"] == "new-session"
        && (!crate::terminal_transport::directory(id)
            || id.ends_with('/') && id != "/" && !(id.len() == 3 && id.as_bytes()[1] == b':'))
    {
        return Err("writer_target_invalid".into());
    }
    Ok(value.clone())
}
fn records(state: &State) -> Result<Vec<Value>> {
    let Some(value) = state.extra.get(FIELD) else {
        return Ok(Vec::new());
    };
    policy::keys(
        value,
        &["schemaVersion", "held"],
        &["schemaVersion", "held"],
    )?;
    if value["schemaVersion"] != 1 {
        return Err("writer_store_invalid".into());
    }
    let rows = value["held"]
        .as_array()
        .filter(|rows| rows.len() <= MAX)
        .ok_or("writer_store_invalid")?;
    for (index, row) in rows.iter().enumerate() {
        policy::keys(
            row,
            &["hostID", "target", "windowKey", "grantID", "authority"],
            &["hostID", "target", "windowKey", "grantID"],
        )?;
        identity(row, "hostID", 512)?;
        identity(row, "grantID", 128)?;
        crate::file_journal::window_namespace(identity(row, "windowKey", 128)?)
            .map_err(str::to_owned)?;
        target(&row["target"])?;
        if let Some(authority) = row.get("authority") {
            policy::keys(
                authority,
                &["origin", "authorizationID"],
                &["origin", "authorizationID"],
            )?;
            let origin = policy::string(authority, "origin")?;
            if policy::editor_origin(origin)? != origin {
                return Err("writer_store_invalid".into());
            }
            identity(authority, "authorizationID", 128)?;
        }
        if rows[..index].iter().any(|prior| {
            prior["grantID"] == row["grantID"]
                || prior["hostID"] == row["hostID"] && prior["target"] == row["target"]
        }) {
            return Err("writer_store_invalid".into());
        }
    }
    Ok(rows.clone())
}
fn persist(actor: &mut Actor, held: Vec<Value>) -> Result<()> {
    let mut state = actor.state().clone();
    state
        .extra
        .insert(FIELD.into(), json!({"schemaVersion":1,"held":held}));
    actor.commit(state, false).map(|_| ())
}
fn decode(segment: &str) -> Result<String> {
    let mut bytes = segment.bytes();
    let mut out = Vec::new();
    while let Some(byte) = bytes.next() {
        out.push(if byte == b'%' {
            let a = bytes
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or("writer_target_invalid")?;
            let b = bytes
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or("writer_target_invalid")?;
            (a * 16 + b) as u8
        } else {
            byte
        });
    }
    String::from_utf8(out).map_err(|_| "writer_target_invalid".into())
}
fn route_target(path: &str, method: &str) -> Result<Option<Value>> {
    if method == "GET" {
        return Ok(None);
    }
    let decoded = policy::route(path, false)?;
    let raw = path.split('?').next().unwrap_or("");
    // Preserve one encoded entity segment (including %2F in IDs). Encoded route
    // aliases never evade a gate by changing how an upstream router splits paths.
    for (prefix, kind) in [
        ("/api/session/", "session"),
        ("/api/yuri/assistants/", "assistant"),
    ] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            let id = decode(rest.split('/').next().unwrap_or(""))?;
            return target(&json!({"kind":kind,"id":id})).map(Some);
        }
        if decoded.starts_with(prefix) {
            return Err("writer_target_invalid".into());
        }
    }
    if decoded == "/api/session"
        || decoded.starts_with("/api/rpc/") && !decoded.ends_with("opencode.goal/get")
    {
        return Err("writer_target_unavailable".into());
    }
    Ok(None)
}
impl Actor {
    pub(super) fn writer_call(&mut self, name: &str, value: &Value) -> Result<Value> {
        let port = self.writer.clone().ok_or("writer_unsupported")?;
        port.call(self, name, value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_gate_preserves_encoded_entity_segments_and_rejects_aliases_and_unscoped_mutations() {
        assert_eq!(
            route_target("/api/session/a%2Fb/prompt?directory=%2Fworkspace", "POST").unwrap(),
            Some(json!({"kind":"session","id":"a/b"}))
        );
        assert_eq!(
            route_target("/api/yuri/assistants/bot%2Fa/session/abort", "POST").unwrap(),
            Some(json!({"kind":"assistant","id":"bot/a"}))
        );
        assert_eq!(route_target("/api/session/a/message", "GET").unwrap(), None);
        for path in [
            "/api/%73ession/a/prompt",
            "/api%2Fsession/a/prompt",
            "/api/yuri/%61ssistants/a/messages",
            "/api/session",
            "/api/rpc/opencode.session/prompt",
        ] {
            assert!(route_target(path, "POST").is_err(), "{path}");
        }
        assert_eq!(
            route_target("/api/rpc/opencode.goal/get", "POST").unwrap(),
            None
        );
    }
    #[test]
    fn pending_or_unknown_close_never_even_attempts_to_load_or_release_a_durable_grant() {
        struct NoVault;
        impl Vault for NoVault {
            fn read(&self) -> Result<Option<Vec<u8>>> {
                panic!("no retirement I/O")
            }
            fn write(&self, _: &[u8]) -> Result<()> {
                panic!("no retirement I/O")
            }
        }
        struct Offline;
        impl Network for Offline {
            fn fetch(&self, _: HttpRequest, _: nsh_engine::FetchEvents) -> Box<dyn FetchTask> {
                panic!("no network")
            }
        }
        let book = Arc::new(Mutex::new(Book::default()));
        let port = Port {
            book: book.clone(),
            window: "native-window".into(),
            key: "primary".into(),
        };
        book.lock().unwrap().active.insert(
            "grant".into(),
            Active {
                authority: Value::Null,
                window: "native-window".into(),
                owner: "owner".into(),
                scope: Value::Null,
                pending: 1,
                unknown: false,
            },
        );
        let (tx, _) = mpsc::sync_channel(1);
        let mut actor = Actor::new(
            HostChannel::default(),
            tx,
            Box::new(NoVault),
            Arc::new(Offline),
        );
        assert!(port.final_close(&mut actor).is_err());
        drop(Guard {
            book: book.clone(),
            id: "grant".into(),
            complete: false,
        });
        let locked = book.lock().unwrap();
        assert_eq!(locked.active["grant"].pending, 0);
        assert!(locked.active["grant"].unknown);
        drop(locked);
        assert!(port.final_close(&mut actor).is_err());
        assert_eq!(book.lock().unwrap().active.len(), 1);
    }
}
