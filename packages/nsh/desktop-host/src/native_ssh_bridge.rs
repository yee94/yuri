//! HostChannel admission for the owning SSH service. No second actor, Vault or sync I/O.
use crate::{connection_actor_port, policy, ssh};
use nsh_engine::HostReply;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

pub const METHODS: &[&str] = &[
    "desktop.ssh.capabilities",
    "desktop.ssh.read",
    "desktop.ssh.save",
    "desktop.ssh.remove",
    "desktop.ssh.start",
    "desktop.ssh.cancel",
];
type Completion = Box<dyn FnOnce() + Send>;
#[derive(Default)]
struct Stopped {
    done: AtomicBool,
    failure: Mutex<Option<ssh::Error>>,
    completion: Mutex<Option<Completion>>,
}
impl Stopped {
    fn finish(&self, result: ssh::Result<()>) {
        if let Err(error) = result {
            *self.failure.lock().expect("SSH stop failure gate") = Some(error);
            // Keep teardown pending: a stopped worker with unresolved retirement is
            // not proof that the original actor's authority may be destroyed.
            return;
        }
        let completion = {
            let mut completion = self.completion.lock().expect("SSH completion gate");
            self.done.store(true, Ordering::Release);
            completion.take()
        };
        if let Some(completion) = completion {
            completion();
        }
    }
}
#[derive(Clone)]
pub struct Control {
    handle: Option<ssh::service::Handle>,
    stopped: Arc<Stopped>,
}
impl Control {
    #[cfg(test)]
    pub fn phase(&self) -> Option<ssh::service::Phase> {
        self.handle.as_ref().map(ssh::service::Handle::phase)
    }
    pub fn shutdown(&self) {
        if let Some(handle) = &self.handle {
            handle.shutdown();
        }
    }
    pub fn stopped(&self) -> bool {
        self.stopped.done.load(Ordering::Acquire)
    }
    pub fn shutdown_failure(&self) -> Option<ssh::Error> {
        self.stopped
            .failure
            .lock()
            .map_or(Some(ssh::Error::CommitUnknown), |failure| *failure)
    }
    /// One Host owner registers teardown after successful retirement only. A failed
    /// on_stopped keeps this pending and is exposed separately by shutdown_failure.
    /// Never wait on the UI or original actor.
    pub fn after_stopped(&self, completion: Completion) {
        let mut slot = self.stopped.completion.lock().expect("SSH completion gate");
        if self.stopped() && self.shutdown_failure().is_none() {
            drop(slot);
            completion();
        } else {
            assert!(slot.is_none(), "single SSH teardown owner");
            *slot = Some(completion);
        }
    }
    fn capabilities(&self) -> Value {
        let (supported, phase) = match self.handle.as_ref().map(ssh::service::Handle::phase) {
            Some(ssh::service::Phase::Ready) => (true, "ready"),
            Some(ssh::service::Phase::Starting) => (false, "starting"),
            Some(ssh::service::Phase::Stopping) => (false, "stopping"),
            Some(ssh::service::Phase::Stopped) => (false, "stopped"),
            Some(ssh::service::Phase::Failed(_)) => (false, "failed"),
            None => (false, "unsupported"),
        };
        json!({"version":1,"connections":{"supported":supported,"phase":phase,"maxPending":ssh::service::CAPACITY},"sync":{"supported":false}})
    }
}

/// Called before JS load; service creation/load happens only on the owning worker.
pub fn install(
    port: connection_actor_port::Port,
    driver: ssh::Result<Arc<dyn ssh::Driver>>,
    version: String,
) -> policy::Result<Control> {
    let stopped = Arc::new(Stopped::default());
    let handle = match driver {
        Ok(driver) => {
            let finished = stopped.clone();
            Some(
                ssh::service::install(
                    port,
                    driver,
                    version,
                    Box::new(|_| {}),
                    Box::new(move |result| finished.finish(result)),
                )
                .map_err(|e| e.code().to_owned())?,
            )
        }
        Err(_) => {
            stopped.finish(Ok(()));
            None
        }
    };
    Ok(Control { handle, stopped })
}
impl Control {
    /// Original actor calls this after bounded HostChannel admission, never on the engine thread.
    pub fn call(&self, method: &str, input: Value, reply: HostReply) {
        if method == "desktop.ssh.capabilities" {
            reply.reply(policy::keys(&input, &[], &[]).map(|_| self.capabilities()));
            return;
        }
        let request = match parse(method, &input) {
            Ok(request) => request,
            Err(error) => {
                reply.reject(error.code());
                return;
            }
        };
        let Some(handle) = &self.handle else {
            reply.reject("ssh_unavailable");
            return;
        };
        if let ssh::service::Phase::Failed(error) = handle.phase() {
            reply.reject(error.code());
            return;
        }
        let pending = Arc::new(Mutex::new(Some(reply)));
        let delivered = pending.clone();
        let result = handle.submit(
            request,
            ssh::Cancellation::default(),
            Box::new(move |outcome| {
                if let Some(reply) = delivered.lock().expect("SSH reply gate").take() {
                    settle(reply, outcome);
                }
            }),
        );
        if let Err(error) = result
            && let Some(reply) = pending.lock().expect("SSH reply gate").take()
        {
            reply.reject(error.code());
        }
    }
}
fn settle(reply: HostReply, outcome: ssh::service::Outcome) {
    match outcome {
        ssh::service::Outcome::Complete(value) => reply.resolve(value),
        ssh::service::Outcome::Denied(error) | ssh::service::Outcome::Unknown(error) => {
            reply.reject(error.code())
        }
    }
}
fn parse(method: &str, input: &Value) -> ssh::Result<ssh::service::Request> {
    use ssh::service::Request;
    if serde_json::to_vec(input).map_or(true, |v| v.len() > 16 * 1024) {
        return Err(ssh::Error::Invalid);
    }
    let keys: &[&str] = match method {
        "desktop.ssh.read" => &[],
        "desktop.ssh.save" => &["requestID", "revision", "instance"],
        "desktop.ssh.remove" => &["requestID", "revision", "id"],
        "desktop.ssh.start" => &["requestID", "id", "intent"],
        "desktop.ssh.cancel" => &["id", "attempt"],
        _ => return Err(ssh::Error::Invalid),
    };
    policy::keys(input, keys, keys).map_err(|_| ssh::Error::Invalid)?;
    let id = |key: &str| {
        input[key]
            .as_str()
            .filter(|s| ssh::identifier(s))
            .map(str::to_owned)
            .ok_or(ssh::Error::Invalid)
    };
    let number = |key: &str, minimum| {
        input[key]
            .as_u64()
            .filter(|v| *v >= minimum && *v <= 9_007_199_254_740_000)
            .ok_or(ssh::Error::Invalid)
    };
    Ok(match method {
        "desktop.ssh.read" => Request::Snapshot,
        "desktop.ssh.save" => Request::Save {
            request_id: id("requestID")?,
            revision: number("revision", 0)?,
            instance: ssh::Instance::parse(&input["instance"])?,
        },
        "desktop.ssh.remove" => Request::Remove {
            request_id: id("requestID")?,
            revision: number("revision", 0)?,
            id: id("id")?,
        },
        "desktop.ssh.start" => Request::Start {
            request_id: id("requestID")?,
            id: id("id")?,
            intent: match input["intent"].as_str() {
                Some("connect") => ssh::Intent::Connect,
                Some("restore") => ssh::Intent::Restore,
                Some("check") => ssh::Intent::Check,
                _ => return Err(ssh::Error::Invalid),
            },
        },
        "desktop.ssh.cancel" => Request::Cancel {
            id: id("id")?,
            attempt: number("attempt", 1)?,
        },
        _ => return Err(ssh::Error::Invalid),
    })
}

/// Fixed OS-owned executable only. No PATH, environment override, chooser or JS path.
pub fn native_driver() -> ssh::Result<Arc<dyn ssh::Driver>> {
    #[cfg(target_os = "macos")]
    {
        use std::{os::unix::fs::MetadataExt, path::Path};
        let path = Path::new("/usr/bin/ssh");
        for current in [
            Path::new("/"),
            Path::new("/usr"),
            Path::new("/usr/bin"),
            path,
        ] {
            let metadata =
                std::fs::symlink_metadata(current).map_err(|_| ssh::Error::Unavailable)?;
            if metadata.file_type().is_symlink()
                || metadata.uid() != 0
                || metadata.mode() & 0o022 != 0
                || !deny_only_acl(current)
                || (current == path && (!metadata.is_file() || metadata.mode() & 0o111 == 0))
                || (current != path && !metadata.is_dir())
            {
                return Err(ssh::Error::Unavailable);
            }
        }
        Ok(Arc::new(ssh::process::NativeDriver::new(path.to_owned())?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(ssh::Error::Unavailable)
    }
}

#[cfg(target_os = "macos")]
fn deny_only_acl(path: &std::path::Path) -> bool {
    use std::{
        ffi::{CString, c_void},
        os::unix::ffi::OsStrExt,
    };
    unsafe extern "C" {
        fn acl_get_file(path: *const std::ffi::c_char, kind: i32) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: i32, entry: *mut *mut c_void) -> i32;
        fn acl_get_tag_type(entry: *mut c_void, tag: *mut i32) -> i32;
        fn acl_free(value: *mut c_void) -> i32;
    }
    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let acl = unsafe { acl_get_file(path.as_ptr(), 0x100) };
    if acl.is_null() {
        return false;
    }
    let mut valid = false;
    for index in 0..256 {
        let mut entry = std::ptr::null_mut();
        let status = unsafe { acl_get_entry(acl, if index == 0 { 0 } else { -1 }, &mut entry) };
        if status != 0 {
            valid = std::io::Error::last_os_error().raw_os_error() == Some(22);
            break;
        }
        let mut tag = 0;
        if entry.is_null() || unsafe { acl_get_tag_type(entry, &mut tag) } != 0 || tag != 2 {
            break;
        }
    }
    unsafe {
        acl_free(acl);
    }
    valid
}
