//! The same admission proof as notification-core.ts / iOS NativeNotificationAdmission.
use serde_json::{Value, json};
pub type Result<T> = std::result::Result<T, String>;
pub const INVALID: &str = "notification_invalid";
pub const STALE: &str = "notification_stale";
pub const UNAVAILABLE: &str = "notification_unavailable";
pub const KINDS: &[&str] = &[
    "completion",
    "subtask",
    "error",
    "question",
    "permission",
    "schedule",
    "assistant",
    "goal",
];
pub const LANGUAGES: &[&str] = &[
    "en", "zh-CN", "zh-TW", "ja", "ko", "fr", "es", "pl", "pt-BR", "uk",
];
pub fn keys(value: &Value, names: &[&str]) -> Result<()> {
    let map = value.as_object().ok_or(INVALID)?;
    if map.len() != names.len() || names.iter().any(|k| !map.contains_key(*k)) {
        return Err(INVALID.into());
    }
    Ok(())
}
pub fn id(value: &Value, limit: usize) -> Result<&str> {
    let s = value.as_str().ok_or(INVALID)?;
    if s.is_empty()
        || s.len() > limit
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(INVALID.into());
    }
    Ok(s)
}
pub fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
pub fn target(value: &Value) -> Result<()> {
    keys(value, &["kind", "id"])?;
    if !["session", "assistant", "schedule"].contains(&value["kind"].as_str().unwrap_or("")) {
        return Err(INVALID.into());
    }
    id(&value["id"], 128)?;
    Ok(())
}
pub fn admission(value: &Value) -> Result<()> {
    keys(value, &["v", "kind", "eventID", "target", "source"])?;
    if value["v"].as_u64() != Some(1) {
        return Err(INVALID.into());
    }
    target(&value["target"])?;
    let source = &value["source"];
    let kind = value["kind"].as_str().ok_or(INVALID)?;
    let (parts, target_kind, target_id) = match kind {
        "completion" | "subtask" | "error" | "question" | "permission" | "goal" => {
            keys(
                source,
                &["type", "sessionID", "directory", "parentID", "boundaryID"],
            )?;
            let directory = source["directory"].as_str().ok_or(INVALID)?;
            if source["type"] != "session"
                || directory.trim().is_empty()
                || directory.encode_utf16().count() > 4096
                || directory.contains('\0')
            {
                return Err(INVALID.into());
            }
            if kind == "subtask" {
                id(&source["parentID"], 128)?;
            } else if !source["parentID"].is_null() {
                return Err(INVALID.into());
            }
            let session = id(&source["sessionID"], 128)?;
            (
                vec![session, id(&source["boundaryID"], 128)?],
                "session",
                session,
            )
        }
        "assistant" => {
            keys(
                source,
                &["type", "assistantID", "turnID", "status", "publication"],
            )?;
            if source["type"] != "assistant"
                || source["publication"] != "published"
                || !["complete", "error"].contains(&source["status"].as_str().unwrap_or(""))
            {
                return Err(INVALID.into());
            }
            let assistant = id(&source["assistantID"], 128)?;
            (
                vec![assistant, id(&source["turnID"], 128)?],
                "assistant",
                assistant,
            )
        }
        "schedule" => {
            keys(
                source,
                &[
                    "type",
                    "projectID",
                    "taskID",
                    "runID",
                    "trigger",
                    "resultOwner",
                    "status",
                ],
            )?;
            if source["type"] != "schedule"
                || source["trigger"] != "scheduled"
                || source["resultOwner"] != "unowned"
                || !["success", "error"].contains(&source["status"].as_str().unwrap_or(""))
            {
                return Err(INVALID.into());
            }
            let task = id(&source["taskID"], 128)?;
            (
                vec![
                    id(&source["projectID"], 128)?,
                    task,
                    id(&source["runID"], 128)?,
                ],
                "schedule",
                task,
            )
        }
        _ => return Err(INVALID.into()),
    };
    let expected = format!(
        "admitted_{}_{}",
        kind,
        parts
            .iter()
            .map(|s| format!("{}_{}", s.len(), s))
            .collect::<Vec<_>>()
            .join("_")
    );
    if id(&value["eventID"], 384)? != expected
        || value["target"]["kind"] != target_kind
        || value["target"]["id"] != target_id
    {
        return Err(INVALID.into());
    }
    Ok(())
}
pub fn record(value: &Value) -> Result<()> {
    keys(
        value,
        &[
            "v",
            "receipt",
            "revision",
            "connectionID",
            "authorizationID",
            "admission",
            "createdAt",
            "expiresAt",
        ],
    )?;
    if value["v"].as_u64() != Some(1)
        || !uuid(value["receipt"].as_str().ok_or(INVALID)?)
        || value["revision"]
            .as_u64()
            .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
            .is_none()
    {
        return Err(INVALID.into());
    }
    id(&value["connectionID"], 128)?;
    if id(&value["authorizationID"], 128)? == "legacy" {
        return Err(INVALID.into());
    }
    let created = value["createdAt"].as_u64().ok_or(INVALID)?;
    let expires = value["expiresAt"].as_u64().ok_or(INVALID)?;
    if expires <= created || expires - created > 604_800_000 {
        return Err(INVALID.into());
    }
    admission(&value["admission"])
}
pub fn status(authorization: &str, alert: &str, sound: &str, badge: &str) -> Value {
    json!({"authorization": authorization, "alert": alert, "sound": sound, "badge": badge, "backgroundPush": false})
}
pub fn copy(language: &str, test: bool) -> (&'static str, &'static str) {
    let (title, body, live) = match language {
        "zh-CN" => (
            "测试通知",
            "这是一条来自 Yuri 的测试通知。",
            "打开 Yuri 查看最新动态。",
        ),
        "zh-TW" => (
            "測試通知",
            "這是一則來自 Yuri 的測試通知。",
            "開啟 Yuri 查看最新動態。",
        ),
        "ja" => (
            "テスト通知",
            "これは Yuri からのテスト通知です。",
            "Yuri を開いて更新を確認してください。",
        ),
        "ko" => (
            "테스트 알림",
            "Yuri에서 보낸 테스트 알림입니다.",
            "Yuri를 열어 새 소식을 확인하세요.",
        ),
        "fr" => (
            "Notification de test",
            "Ceci est une notification de test de Yuri.",
            "Ouvrez Yuri pour consulter la mise à jour.",
        ),
        "es" => (
            "Notificación de prueba",
            "Esta es una notificación de prueba de Yuri.",
            "Abre Yuri para ver la actualización.",
        ),
        "pl" => (
            "Powiadomienie testowe",
            "To jest powiadomienie testowe od Yuri.",
            "Otwórz Yuri, aby zobaczyć aktualizację.",
        ),
        "pt-BR" => (
            "Notificação de teste",
            "Esta é uma notificação de teste do Yuri.",
            "Abra o Yuri para ver a atualização.",
        ),
        "uk" => (
            "Тестове сповіщення",
            "Це тестове сповіщення від Yuri.",
            "Відкрийте Yuri, щоб переглянути оновлення.",
        ),
        _ => (
            "Test Notification",
            "This is a test notification from Yuri.",
            "Open Yuri to view the update.",
        ),
    };
    if test { (title, body) } else { ("Yuri", live) }
}
