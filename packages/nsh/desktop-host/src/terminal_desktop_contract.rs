//! Fixed document/renderer messages, independent of the PTY transport or OS.
use serde_json::{Value, json};
type Result<T> = std::result::Result<T, String>;
const SAFE: u64 = 9_007_199_254_740_991;
pub const DOCUMENT_URL: &str = "https://terminal.invalid/viewport";

#[derive(Default)]
pub struct OfflineDocument {
    navigation: bool,
    resource: bool,
}
impl OfflineDocument {
    pub fn arm(&mut self) {
        self.navigation = true;
        self.resource = true;
    }
    pub fn navigation(&mut self, uri: &str, current: bool) -> bool {
        let allowed = current && self.navigation && uri == DOCUMENT_URL;
        if allowed {
            self.navigation = false;
        }
        allowed
    }
    pub fn resource(&mut self, uri: &str, method: &str, context: i32, current: bool) -> bool {
        let allowed = current
            && !self.navigation
            && self.resource
            && uri == DOCUMENT_URL
            && method == "GET"
            && context == 1;
        if allowed {
            self.resource = false;
        }
        allowed
    }
}
fn number(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= SAFE)
}
fn key(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
}
pub fn authority(value: &Value) -> Result<Value> {
    if !key(&value["owner"]) || !number(&value["generation"]) || value["generation"] == 0 {
        return Err("terminal_owner_invalid".into());
    }
    let scope = crate::policy::scope(&value["expectedHost"])?;
    Ok(json!({"owner":value["owner"],"generation":value["generation"],"expectedHost":scope}))
}
pub fn matches(authority: &Value, value: &Value) -> bool {
    ["owner", "generation", "expectedHost"]
        .iter()
        .all(|field| authority[*field] == value[*field])
}
pub fn command(name: &str, value: &Value) -> bool {
    match name {
        "shortcuts" => value["bindings"].as_array().is_some_and(|rows| {
            rows.len() <= 256
                && rows.iter().all(|row| {
                    row["actionId"].as_str().is_some_and(|s| {
                        !s.is_empty()
                            && s.len() <= 128
                            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    }) && row["keystroke"].as_str().is_some_and(|s| {
                        !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_graphic())
                    })
                })
        }),
        "focus" => true,
        "layout" => ["width", "height"]
            .iter()
            .all(|k| value[*k].as_f64().is_some_and(|n| n > 0.0 && n <= 32768.0)),
        "inputResult" => {
            key(&value["key"])
                && match value["status"].as_str() {
                    Some("closed" | "retry") => true,
                    Some("accepted" | "rejected" | "unknown" | "suspended") => {
                        number(&value["receipt"]) && value["receipt"] != 0
                    }
                    _ => false,
                }
        }
        "render" => {
            value["type"] == "render"
                && value["key"].as_str().is_some_and(|s| s.len() <= 128)
                && value["live"].is_boolean()
                && number(&value["serial"])
                && value["chunks"].as_array().is_some_and(|chunks| {
                    chunks.len() <= 65536
                        && chunks.iter().all(|c| {
                            number(&c["id"])
                                && c["data"].as_str().is_some_and(|s| s.len() <= 1_048_576)
                        })
                        && chunks
                            .iter()
                            .filter_map(|c| c["data"].as_str())
                            .map(str::len)
                            .sum::<usize>()
                            <= 2_097_152
                })
        }
        _ => false,
    }
}
pub fn event(value: &Value) -> bool {
    match value["type"].as_str() {
        Some("openPreview") => {
            key(&value["key"])
                && matches!(value["mode"].as_str(), Some("preview" | "external"))
                && value["url"].as_str().is_some_and(|url| {
                    url.len() <= 8192
                        && (url.starts_with("https://") || url.starts_with("http://"))
                        && !url
                            .chars()
                            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
                })
        }
        Some("shortcut") => {
            value["actionId"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 128)
                && value["keystroke"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 64)
        }
        Some("ready") => value["version"] == 1,
        Some("ack") => key(&value["key"]) && number(&value["serial"]) && number(&value["cursor"]),
        Some("resize") => {
            value["key"].as_str().is_some_and(|s| s.len() <= 128)
                && value["cols"]
                    .as_u64()
                    .is_some_and(|n| (2..=1000).contains(&n))
                && value["rows"]
                    .as_u64()
                    .is_some_and(|n| (1..=1000).contains(&n))
        }
        Some("input") => {
            key(&value["key"])
                && number(&value["receipt"])
                && value["receipt"] != 0
                && value["data"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 65536)
        }
        Some("focus") => value["focused"].is_boolean(),
        Some("composition") => value["composing"].is_boolean(),
        Some("inputRejected" | "error") => value["code"].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn link_events_are_bounded_data_not_a_navigation_or_host_bridge() {
        assert!(event(
            &json!({"type":"openPreview","key":"tab","url":"http://localhost:3000/","mode":"preview"})
        ));
        assert!(event(
            &json!({"type":"openPreview","key":"tab","url":"https://example.invalid/docs","mode":"external"})
        ));
        for url in [
            "file:///private/data",
            "javascript:alert(1)",
            "https://example.invalid/\nnext",
            "https://example.invalid/\\other",
        ] {
            assert!(!event(
                &json!({"type":"openPreview","key":"tab","url":url,"mode":"external"})
            ));
        }
        assert!(!event(
            &json!({"type":"openPreview","key":"tab","url":"https://example.invalid/","mode":"navigate"})
        ));
        assert!(!command(
            "openPreview",
            &json!({"url":"https://example.invalid/"})
        ));
    }
    #[test]
    fn fixed_offline_document_is_one_shot_and_never_an_arbitrary_resource_proxy() {
        let mut admission = OfflineDocument::default();
        assert!(!admission.navigation(DOCUMENT_URL, true));
        admission.arm();
        assert!(!admission.resource(DOCUMENT_URL, "GET", 1, true));
        for uri in [
            "about:blank",
            "https://example.invalid/",
            "https://terminal.invalid/viewport?x=1",
            "https://terminal.invalid/viewport#fragment",
        ] {
            assert!(!admission.navigation(uri, true));
        }
        assert!(!admission.navigation(DOCUMENT_URL, false));
        assert!(admission.navigation(DOCUMENT_URL, true));
        assert!(!admission.navigation(DOCUMENT_URL, true));
        assert!(!admission.resource(DOCUMENT_URL, "GET", 1, false));
        assert!(!admission.resource(DOCUMENT_URL, "POST", 1, true));
        assert!(!admission.resource(DOCUMENT_URL, "GET", 2, true));
        assert!(!admission.resource("https://terminal.invalid/other", "GET", 1, true));
        assert!(admission.resource(DOCUMENT_URL, "GET", 1, true));
        assert!(!admission.resource(DOCUMENT_URL, "GET", 1, true));
    }
    #[test]
    fn no_navigation_script_or_unsafe_receipt_contract() {
        assert!(!command("eval", &json!({"script":"arbitrary"})));
        assert!(!command(
            "navigate",
            &json!({"url":"https://example.invalid"})
        ));
        assert!(!event(
            &json!({"type":"input","key":"tab","data":"x","receipt":SAFE+1})
        ));
        assert!(event(
            &json!({"type":"input","key":"tab","data":"中\0\r\n","receipt":1})
        ));
        assert!(!event(
            &json!({"type":"host.call","name":"terminal.create"})
        ));
    }
    #[test]
    fn owner_generation_and_exact_lease_all_fence_commands() {
        let input = json!({"owner":"viewport","generation":1,"expectedHost":{"hostID":"synthetic","lease":"00000000-0000-4000-8000-000000000007"}});
        let a = authority(&input).unwrap();
        assert!(matches(&a, &input));
        for (field, value) in [("owner", json!("other")), ("generation", json!(2))] {
            let mut candidate = input.clone();
            candidate[field] = value;
            assert!(!matches(&a, &candidate));
        }
        let mut changed = input;
        changed["expectedHost"]["lease"] = json!("00000000-0000-4000-8000-000000000008");
        assert!(!matches(&a, &changed));
    }
}
