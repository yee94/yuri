//! Existing upload ID/name/MIME rules shared as source by both attachment lanes.
use crate::policy::Result;

pub(super) fn opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
pub(super) fn validate(name: &str, mime: &str, images: bool) -> Result<()> {
    if name.is_empty()
        || name.len() > 1024
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err("attachment_invalid_name".into());
    }
    if mime.len() > 255 {
        return Err("attachment_invalid_mime".into());
    }
    let parts: Vec<_> = mime.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
        })
        || images && !mime.starts_with("image/")
    {
        return Err("attachment_invalid_mime".into());
    }
    Ok(())
}
