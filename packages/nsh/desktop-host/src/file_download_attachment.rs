//! Canonical contact source, never a Host filesystem path or a client URL.
use crate::policy::{self, Result};
use serde_json::Value;

pub const MAX_BYTES: u64 = 25 * 1024 * 1024;

use crate::file_download_attachment_validation::{opaque_id, validate};

#[derive(Clone)]
pub struct Attachment(Value);
impl Attachment {
    pub fn parse(value: &Value) -> Result<Self> {
        policy::keys(
            value,
            &[
                "type",
                "assistantID",
                "attachmentID",
                "sha256",
                "size",
                "mime",
                "filename",
            ],
            &[
                "type",
                "assistantID",
                "attachmentID",
                "sha256",
                "size",
                "mime",
            ],
        )?;
        let digest = policy::string(value, "sha256")?;
        if value["type"] != "file"
            || !opaque_id(policy::string(value, "assistantID")?)
            || !opaque_id(policy::string(value, "attachmentID")?)
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || value["size"]
                .as_u64()
                .is_none_or(|n| n == 0 || n > MAX_BYTES)
        {
            return Err("download_invalid_attachment".into());
        }
        validate(
            match value.get("filename") {
                Some(name) => name.as_str().ok_or("attachment_invalid_name")?,
                None => "attachment",
            },
            policy::string(value, "mime")?,
            false,
        )?;
        Ok(Self(value.clone()))
    }
    pub fn descriptor(&self) -> &Value {
        &self.0
    }
    pub fn path(&self) -> String {
        format!(
            "/api/yuri/assistants/{}/contact/attachments/{}",
            self.0["assistantID"].as_str().unwrap(),
            self.0["attachmentID"].as_str().unwrap()
        )
    }
    pub fn size(&self) -> u64 {
        self.0["size"].as_u64().unwrap()
    }
    pub fn mime(&self) -> &str {
        self.0["mime"].as_str().unwrap()
    }
    pub fn digest(&self) -> &str {
        self.0["sha256"].as_str().unwrap()
    }
    pub fn filename(&self) -> &str {
        self.0["filename"].as_str().unwrap_or("attachment")
    }
}
