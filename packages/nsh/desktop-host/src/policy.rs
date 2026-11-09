use serde_json::{Map, Value};
pub type Result<T> = std::result::Result<T, String>;
pub const BODY_LIMIT: usize = 32 * 1024 * 1024;

pub fn object(value: &Value) -> Result<&Map<String, Value>> {
    value.as_object().ok_or_else(|| "invalid_arguments".into())
}
pub fn keys(value: &Value, allowed: &[&str], required: &[&str]) -> Result<()> {
    let fields = object(value)?;
    if fields.keys().any(|k| !allowed.contains(&k.as_str()))
        || required.iter().any(|k| !fields.contains_key(*k))
    {
        return Err("invalid_arguments".into());
    }
    Ok(())
}
pub fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "invalid_arguments".into())
}
pub fn optional_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    match value.get(key) {
        None => Ok(""),
        Some(Value::String(s)) => Ok(s),
        _ => Err("invalid_arguments".into()),
    }
}
pub fn token(value: &str) -> Result<()> {
    if value.len() > 8192 || !value.bytes().all(|b| b > 32 && b < 127) {
        return Err("invalid_credential".into());
    }
    Ok(())
}

/// Deliberately narrow URL grammar. HTTPS only, with an optional explicit loopback development gate.
/// No parser normalization, userinfo, query, fragment, escaped authority or proxy credentials.
pub fn origin(input: &str, allow_loopback: bool) -> Result<String> {
    canonical_origin(input, allow_loopback, false)
}
/// Syntax-only metadata comparison. This does not authorize an HTTP network connection.
pub(crate) fn editor_origin(input: &str) -> Result<String> {
    canonical_origin(input, false, true)
}
fn canonical_origin(input: &str, allow_loopback: bool, editor: bool) -> Result<String> {
    let invalid = || "invalid_host_origin".to_string();
    let trimmed = input.trim();
    let input = trimmed.strip_suffix('/').unwrap_or(trimmed);
    let (scheme, authority) = input.split_once("://").ok_or_else(invalid)?;
    let scheme = if editor {
        scheme.to_ascii_lowercase()
    } else {
        scheme.to_owned()
    };
    if authority.is_empty()
        || !authority.is_ascii()
        || authority
            .bytes()
            .any(|b| b <= 32 || b >= 127 || b"/@?#%\\".contains(&b))
    {
        return Err(invalid());
    }
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']').ok_or_else(invalid)?;
        let host = &authority[..=end];
        host[1..host.len() - 1]
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| invalid())?;
        (host, &authority[end + 1..])
    } else {
        let end = authority.find(':').unwrap_or(authority.len());
        let host = &authority[..end];
        if host.is_empty()
            || host.len() > 253
            || host.split('.').any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return Err(invalid());
        }
        (host, &authority[end..])
    };
    if !port.is_empty()
        && (!port.starts_with(':')
            || port[1..].is_empty()
            || !port[1..].bytes().all(|b| b.is_ascii_digit())
            || port[1..].parse::<u16>().ok().filter(|v| *v > 0).is_none())
    {
        return Err(invalid());
    }
    let loopback = host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "[::1]";
    if scheme != "https" && !(scheme == "http" && (editor || allow_loopback && loopback)) {
        return Err("https_required".into());
    }
    let port = if (scheme == "https" && port == ":443") || (scheme == "http" && port == ":80") {
        ""
    } else {
        port
    };
    Ok(format!("{scheme}://{}{port}", host.to_ascii_lowercase()))
}

pub fn route(path: &str, authentication: bool) -> Result<String> {
    let invalid = || "invalid_host_path".to_string();
    if path.len() > 32768
        || !path.is_ascii()
        || path.bytes().any(|b| b <= 32 || b >= 127)
        || path.contains('#')
        || path.contains('\\')
    {
        return Err(invalid());
    }
    let raw = path.split('?').next().unwrap_or("");
    let mut decoded = Vec::new();
    let mut bytes = raw.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let a = bytes
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or_else(invalid)?;
            let b = bytes
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or_else(invalid)?;
            decoded.push((a * 16 + b) as u8);
        } else {
            decoded.push(b);
        }
    }
    let decoded = String::from_utf8(decoded).map_err(|_| invalid())?;
    if decoded.contains(['\\', '%', '?', '#'])
        || decoded.bytes().any(|b| b < 32 || b == 127)
        || decoded.contains("//")
        || decoded.split('/').any(|s| s == "." || s == "..")
    {
        return Err(invalid());
    }
    if !(decoded.starts_with("/api/")
        || decoded == "/health"
        || (authentication && decoded == "/auth/session"))
    {
        return Err(invalid());
    }
    if !authentication
        && (decoded.starts_with("/api/client-auth")
            || decoded == "/api/auth"
            || decoded.starts_with("/api/auth/"))
    {
        return Err(invalid());
    }
    // Runtime requests cannot introduce credential-bearing query parameters.
    if let Some(query) = path.split_once('?').map(|(_, q)| q) {
        for field in query.split('&') {
            let key = field.split('=').next().unwrap_or("").to_ascii_lowercase();
            if key.contains('%')
                || [
                    "authorization",
                    "token",
                    "clienttoken",
                    "access_token",
                    "yuri_url_token",
                    "password",
                    "secret",
                ]
                .contains(&key.as_str())
            {
                return Err(invalid());
            }
        }
    }
    Ok(decoded)
}

pub fn scope(value: &Value) -> Result<Value> {
    keys(value, &["hostID", "lease"], &["hostID", "lease"])
        .map_err(|_| "runtime_host_scope_invalid")?;
    let id = string(value, "hostID").map_err(|_| "runtime_host_scope_invalid")?;
    let lease = string(value, "lease").map_err(|_| "runtime_host_scope_invalid")?;
    if id.len() > 256 || id.chars().any(char::is_control) || !uuid(lease) {
        return Err("runtime_host_scope_invalid".into());
    }
    Ok(serde_json::json!({"hostID": id, "lease": lease.to_ascii_lowercase()}))
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origins_are_secure_and_canonical() {
        assert_eq!(
            origin("https://Example.com:443/", false).unwrap(),
            "https://example.com"
        );
        for s in [
            "http://example.com",
            "https://u:p@example.com",
            "https://example.com/path",
            "https://a?token=x",
            "https://a\\@b",
            "https://a:0",
            "https://a:65536",
            "https://%61",
        ] {
            assert!(origin(s, false).is_err(), "{s}");
        }
        assert!(origin("http://127.0.0.1:9876", false).is_err());
        assert!(origin("http://127.0.0.1:9876", true).is_ok());
        assert!(origin("http://127.1", true).is_err());
    }
    #[test]
    fn routes_cannot_escape_or_redeem() {
        for s in [
            "//evil/api/x",
            "https://evil/api/x",
            "/api/../auth/session",
            "/api/%2e%2e/x",
            "/api/%252e%252e/x",
            "/api/%2f/x",
            "/api/auth/x",
            "/api/client-auth/pairing/redeem",
            "/api/x#f",
            "/api/x?yuri_url_token=secret",
            "/api/x?%74oken=secret",
        ] {
            assert!(route(s, false).is_err(), "{s}");
        }
        assert!(
            route(
                "/api/session/a?directory=%2Fproject&cursor=opaque%2Bvalue",
                false
            )
            .is_ok()
        );
        assert!(route("/auth/session", true).is_ok());
    }
    #[test]
    fn lease_shape_is_exact() {
        let value =
            serde_json::json!({"hostID":"host", "lease":"12345678-1234-4321-ABCD-123456789012"});
        assert_eq!(
            scope(&value).unwrap()["lease"],
            "12345678-1234-4321-abcd-123456789012"
        );
        assert!(scope(&serde_json::json!({"hostID":"host", "lease":"bad"})).is_err());
        assert!(
            scope(&serde_json::json!({"hostID":"host", "lease":value["lease"], "extra":true}))
                .is_err()
        );
    }
}
