# Session import

Import normalized historical conversations into the bound Yuri Host through the
**bound project API helper** (`import-session`). This writes through the official
OpenCode `session.import` boundary and updates Yuri's project registry and
session index without replaying prompts, modifying SQLite databases directly, or
relying on UI cookies.

## Availability

1. Run this session's exact `Bound project helper` command (`describe`).
2. Continue only when `importSupported:true` and `commands['import-session']` is
   returned. If the pointer has no bound project helper or `importSupported` is
   false, report session import unavailable on this Host.

## Importing a conversation

Pipe a single JSON object (up to 16 MiB) to the returned `import-session`
command on stdin:

```json
{
  "directory": "/abs/path/to/existing/project",
  "title": "Summarized conversation title",
  "source": "external-tool",
  "sourceId": "external-conversation-id",
  "registerProject": true,
  "messages": [
    { "role": "user", "text": "Question", "time": 1735689600000 },
    {
      "role": "assistant",
      "thinking": "Optional historical reasoning",
      "tools": [
        { "name": "read", "input": { "path": "src/index.ts" }, "output": "..." }
      ],
      "text": "Answer",
      "time": 1735689605000
    }
  ]
}
```

### Input fields

| Field | Requirement | Notes |
| --- | --- | --- |
| `directory` | Required | Existing absolute directory on the bound Host. Missing paths and files fail without implicit directory creation. |
| `messages` or `events` | Required (choose one) | Non-empty ordered array (up to 50,000 items). `messages` entries use `{role: "user" \| "assistant" \| "system", text?, time?, thinking?, tools?}`. `events` entries use `{kind: "user" \| "assistant-text" \| "thinking" \| "tool" \| "marker", text?, time?, name?, input?, output?, incomplete?, isError?}`. |
| `title` | Optional | Preferred display title (up to 500 characters; truncated to 200 on storage). Falls back to the first cleaned user message when omitted. |
| `source` | Optional | Short source identifier (`[a-zA-Z0-9._-]`, up to 64 characters; defaults to `"external"`). |
| `sourceId` | Optional | External conversation ID (up to 256 characters). Supplying `source` + `sourceId` enables deterministic idempotent retries for the same content and destination directory. |
| `parentID` | Optional | Existing Yuri session ID when preserving a parent/child relationship. |
| `registerProject` | Optional | Defaults to `true`. Registers `directory` through Yuri's shared project registry before importing; set `false` when the project is already registered or registration is not wanted. |

### Data preparation guidelines

- **Project directory**: map each conversation to its real existing main project
  root on the bound Host. Collapse temporary or linked git worktrees back to the
  main repository root when appropriate, and skip historical directories that no
  longer exist on disk rather than fabricating empty folders.
- **Titles**: prefer the source tool's own summarized or custom title over raw
  first-turn text. Strip injected system/context XML wrapper tags so they never
  become titles or user bubbles.
- **History fidelity**: preserve original message timestamps (epoch milliseconds
  or ISO-8601 strings) when available. Store tool invocations and reasoning as
  historical entries (`tools` / `thinking`) rather than executing them.

## Output and idempotency

Success returns:

```json
{
  "session": { "id": "ses_...", "title": "...", "directory": "...", "created": 0, "updated": 0 },
  "project": { "id": "...", "path": "..." },
  "imported": true,
  "skipped": false
}
```

- When `source` + `sourceId` are provided and an identical revision already
  exists in the same canonical `directory`, the Host verifies provenance and
  returns `imported:false, skipped:true` without creating a duplicate session.
- If a response is interrupted after commit, retry with the same `source`,
  `sourceId`, `directory` and transcript payload rather than generating a fresh
  random copy.
- Failed calls are unconfirmed. Report the failure and do not fall back to
  direct database edits or replaying historical turns as new prompts.

## Boundaries

- Operates on the bound Host only; remote Host session import is not exposed by
  this helper.
- Never reads or harvests credentials, auth tokens, or browser cookies, and
  never creates missing directories on disk.
- Importing does not switch the UI's active project or open a conversation.
