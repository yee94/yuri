//! Desktop-only SSE namespace. No independent credentials, route or authority.
use crate::{
    policy::{self, Result},
    resources,
};
use serde_json::{Value, json};

pub(super) const MAX_PANEL_STREAMS: usize = 4;
const MAX_ID: u64 = 9_007_199_254_740_991;
const PREFIX: &str = "panel-chat:";

pub(super) fn capabilities() -> Value {
    json!({"schemaVersion":1,"panelChat":{"supported":true,"maxStreams":MAX_PANEL_STREAMS,"keyFormat":"panel-chat:<owner>:<activation>","maxID":MAX_ID,"path":"/api/event","queryKeys":["directory"],"requiresExpectedHost":true}})
}
pub(super) fn is_panel(key: &str) -> bool {
    key.starts_with(PREFIX)
}
pub(super) fn key(value: &Value) -> Result<&str> {
    let key = policy::string(value, "key")?;
    if ["global", "chat"].contains(&key) {
        return Ok(key);
    }
    let valid_id = |s: &str| {
        !s.is_empty()
            && s.len() <= 16
            && !s.starts_with('0')
            && s.bytes().all(|b| b.is_ascii_digit())
            && s.parse::<u64>().is_ok_and(|n| n <= MAX_ID)
    };
    if key.len() <= PREFIX.len() + 33
        && key
            .strip_prefix(PREFIX)
            .and_then(|s| s.split_once(':'))
            .is_some_and(|(owner, activation)| valid_id(owner) && valid_id(activation))
    {
        Ok(key)
    } else {
        Err("runtime_host_scope_invalid".into())
    }
}
pub(super) fn panel_path(path: &str) -> Result<()> {
    policy::route(path, false)?;
    let encoded = path
        .strip_prefix("/api/event?directory=")
        .filter(|s| !s.is_empty())
        .ok_or("unsupported_event_stream")?;
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut bytes = encoded.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let a = bytes
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or("unsupported_event_stream")?;
            let b = bytes
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or("unsupported_event_stream")?;
            decoded.push((a * 16 + b) as u8);
        } else {
            decoded.push(b);
        }
    }
    let directory = String::from_utf8(decoded).map_err(|_| "unsupported_event_stream")?;
    // Exact encodeURIComponent wire from the captured TS target; no extra query,
    // ambiguous normalization, credential parameter, or redirect to another endpoint.
    if directory.chars().any(char::is_control) || resources::encoded(&directory) != encoded {
        return Err("unsupported_event_stream".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_canonical_positive_safe_integer_keys_are_admitted() {
        for value in [
            "global",
            "chat",
            "panel-chat:1:1",
            "panel-chat:9007199254740991:9007199254740991",
        ] {
            assert_eq!(key(&json!({"key":value})).unwrap(), value);
        }
        for value in [
            "",
            "panel-chat:1",
            "panel-chat:0:1",
            "panel-chat:1:0",
            "panel-chat:01:1",
            "panel-chat:1:+1",
            "panel-chat:1:1.0",
            "panel-chat:1:1e1",
            "panel-chat:1:9007199254740992",
            "panel-chat:18446744073709551616:1",
            "panel-chat:1:1:1",
            "panel-chat:１:1",
            "chat:1:1",
            "panel-chat:1:1\0",
            "panel-chat:1:1 ",
        ] {
            assert!(key(&json!({"key":value})).is_err(), "{value:?}");
        }
        for value in [
            Value::Null,
            json!({}),
            json!({"key":1}),
            json!({"key":true}),
        ] {
            assert!(key(&value).is_err());
        }
        for n in 1..=1024 {
            let good = format!("panel-chat:{n}:{}", MAX_ID - n);
            assert!(key(&json!({"key":good})).is_ok());
            for bad in [
                format!("{good}:"),
                format!("{good}/"),
                format!(" {good}"),
                format!("panel-chat:0{n}:1"),
            ] {
                assert!(key(&json!({"key":bad})).is_err());
            }
        }
        for byte in 0u8..=127 {
            if byte.is_ascii_digit() {
                continue;
            }
            for index in 0..=3 {
                let mut component = "123".to_owned();
                component.insert(index, byte as char);
                assert!(key(&json!({"key":format!("panel-chat:{component}:1")})).is_err());
            }
        }
    }
    #[test]
    fn panel_stream_is_only_one_exact_encoded_directory_query() {
        for directory in [
            "/synthetic/worktree",
            "C:\\Synthetic Folder\\项目",
            "/x?y&z=1%+#",
        ] {
            assert!(
                panel_path(&format!(
                    "/api/event?directory={}",
                    resources::encoded(directory)
                ))
                .is_ok()
            );
        }
        for path in [
            "/api/yuri/events",
            "/api/event",
            "/api/event?directory=",
            "/api/event?directory=/x",
            "/api/event?directory=%2Fx&directory=%2Fy",
            "/api/event?directory=%2Fx&sessionID=s",
            "/api/event?directory=%2Fx&token=x",
            "/api/event?directory=%00",
            "/api/event?directory=%FF",
            "/api/event?directory=%2",
            "/api/event?directory=%GG",
            "/api/event?directory=%2fx",
            "/api/event?directory=a+b",
            "/api/event?directory=%2Fx#fragment",
            "/api/event/?directory=%2Fx",
            "/api/%65vent?directory=%2Fx",
        ] {
            assert!(panel_path(path).is_err(), "{path}");
        }
        assert!(panel_path(&format!("/api/event?directory={}", "x".repeat(32768))).is_err());
    }
}
