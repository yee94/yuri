//! Attachment worker -> bounded actor mailbox. Raw native bytes never pass through JS/JSON.
use super::*;
use crate::attachments::{self, Transport, Upload, UploadResult};

pub(super) struct Pending {
    pub scope: Value,
    pub upload: Upload,
    pub cancelled: Arc<AtomicBool>,
    pub reply: SyncSender<UploadResult>,
}
pub(super) struct NativeTransport {
    pub tx: SyncSender<Message>,
    pub authority: host_services::Reader,
    pub stop: Arc<AtomicBool>,
}
impl Transport for NativeTransport {
    fn current(&self, scope: &Value) -> bool {
        !self.stop.load(Ordering::Acquire) && self.authority.current(scope)
    }
    fn upload(&self, scope: &Value, upload: Upload, cancelled: &AtomicBool) -> UploadResult {
        if cancelled.load(Ordering::Acquire) || !self.current(scope) {
            return UploadResult::Denied;
        }
        let (reply, result) = mpsc::sync_channel(1);
        let fence = Arc::new(AtomicBool::new(false));
        if self
            .tx
            .try_send(Message::Upload(Pending {
                scope: scope.clone(),
                upload,
                cancelled: fence.clone(),
                reply,
            }))
            .is_err()
        {
            return UploadResult::Denied;
        }
        let deadline = Instant::now() + Duration::from_secs(35);
        loop {
            // Only prevents queued dispatch. A dispatched write still returns a known late receipt
            // if available, so cancellation can account for temporary server files.
            if cancelled.load(Ordering::Acquire) {
                fence.store(true, Ordering::Release);
            }
            match result.recv_timeout(Duration::from_millis(50)) {
                Ok(value) => return value,
                Err(mpsc::RecvTimeoutError::Disconnected) => return UploadResult::Unknown,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if Instant::now() >= deadline {
                fence.store(true, Ordering::Release);
                return UploadResult::Unknown;
            }
        }
    }
}
pub(super) fn request(connection: &Connection, upload: Upload) -> Result<(String, HttpRequest)> {
    let assistant = attachments::assistant_upload_path(&upload.path);
    if !assistant {
        let id = upload
            .path
            .strip_prefix("/api/fs/prompt-attachments/")
            .and_then(|value| value.strip_suffix("?storage=temporary"))
            .ok_or("attachment_upload_path_invalid")?;
        policy::scope(&json!({"hostID":"attachment","lease":id}))?;
    }
    if upload.bytes.is_empty()
        || upload.bytes.len() > attachments::FILE_LIMIT
        || upload.headers.len() != if assistant { 4 } else { 5 }
    {
        return Err("attachment_upload_invalid".into());
    }
    let names: &[&str] = if assistant {
        &[
            "content-type",
            "x-content-size",
            "x-content-sha256",
            "x-attachment-filename",
        ]
    } else {
        &[
            "content-type",
            "x-yuri-content-length",
            "x-yuri-sha256",
            "x-yuri-mime",
            "x-yuri-filename",
        ]
    };
    let mut values = HashMap::new();
    for (name, value) in &upload.headers {
        let name = name.to_ascii_lowercase();
        if !names.contains(&name.as_str())
            || !value.is_ascii()
            || value.len() > 8192
            || value.bytes().any(|byte| byte < 32 || byte == 127)
            || values.insert(name, value.as_str()).is_some()
        {
            return Err("attachment_upload_headers_invalid".into());
        }
    }
    let digest = values[if assistant {
        "x-content-sha256"
    } else {
        "x-yuri-sha256"
    }];
    if values[if assistant {
        "x-content-size"
    } else {
        "x-yuri-content-length"
    }]
    .parse::<usize>()
    .ok()
        != Some(upload.bytes.len())
        || !assistant && values["content-type"] != values["x-yuri-mime"]
        || !values["content-type"].contains('/')
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("attachment_upload_headers_invalid".into());
    }
    let mut request = make_request(connection, &upload.path, "PUT", None, false)?;
    request.headers.extend(upload.headers);
    request = request.body(upload.bytes);
    Ok((upload.path, request))
}

#[cfg(test)]
#[path = "attachments_actor_tests.rs"]
mod tests;
