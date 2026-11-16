# Yuri deep links

Use this reference when the user wants a clickable `yuri://` link that opens Yuri on a conversation, project or new session, for example to paste into an IM message, a note, or the output of a scheduled job. A deep link is navigation only. It carries no authorization, so it never replaces the bound project helper for archiving, registering projects or reading remote sessions.

## Link shapes

Build the URL with `encodeURIComponent` for every id and path. Put paths in the `directory` query key; `dir` and `path` are accepted aliases, but emit `directory`.

| Goal | Link | Desktop | Mobile |
|---|---|---|---|
| Open a conversation | `yuri://session/<sessionID>?directory=<path>` | yes | yes |
| Start a new conversation | `yuri://new-session?directory=<path>&prompt=<text>` | yes | yes |
| Open a project | `yuri://open-project?directory=<path>` | yes | yes |
| Switch to a configured Host | `yuri://host/<hostId>` | yes | no |
| Open Settings at a section | `yuri://settings/<section>` | no | yes |

`new-session` also accepts `project`, `agent` and `model`; omit them unless the user named them. Unknown routes are ignored without an error.

Never generate `yuri://connect?...` links yourself. They carry pairing credentials and trigger a user confirmation to import a connection. Do not put tokens, passwords or secrets in any deep link.

## Opening a conversation

`sessionID` is the OpenCode session id (`ses_...`). `directory` is the absolute path of the project on the machine where the session runs. Always include it when you know it.

Yuri resolves the link on the machine where the link is clicked:

1. If the session id is in that Yuri's own session index, it opens it.
2. Otherwise `directory` must belong to exactly one Remote Project already connected in that Yuri; Yuri then opens the session through that project.
3. In every other case Yuri shows a "conversation not found" notice and opens nothing. It never guesses a machine, and never connects one automatically.

So a link written on a remote machine only works for people whose Yuri already has that machine's project connected, and the path must be the machine's own path. If two connected machines share the same path, the link is ambiguous and will not open. Say this limit when the user plans to share the link; do not promise the recipient can open it. Desktop support for the remote branch is part of the desktop app; mobile opens only sessions in its own index.

## Where the current session id comes from

Use ids from this session's context or from the bound project helper's `task-sessions` and `remote-projects` results. Do not invent an id, and do not derive it from a title. If the id or directory is unknown, say so instead of emitting a link that cannot resolve.

## Verification

Report the link text, which branch should resolve it (local index or connected Remote Project), and the known limits above. Do not run `open "yuri://..."` to verify unless the user asks, because that moves their running Yuri window.
