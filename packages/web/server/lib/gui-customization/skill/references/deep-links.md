# Yuri deep links

Use this reference to compose navigation links to Yuri resources. A deep link is navigation only; resource discovery and authorized operations follow [resource identity and scope](projects.md#resource-identity-and-scope).

## Resolve before building

1. Establish the requested resource's owning instance, raw directory and exact existing ID through the available context or discovery tools. For a session ID, use this session's context, the bound helper's `task-sessions`, or remote `sessions` / `read-session` results. `remote-projects` supplies project scope, not session IDs.
2. Keep the discovered ownership with the resource, then choose a supported link shape below for the receiving client. Navigation preserves existing IDs; it does not create or rewrite them.
3. Report the receiving client's prerequisites separately from the facts confirmed on the generating Host. Finding a remote session does not prove that another client has the corresponding project connected. Missing or ambiguous ownership means report the limitation rather than promise a resolvable link.

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

`hostId` and `instanceId` are not supported session-link parameters. The standalone `host` route switches to a saved desktop connection; it does not scope a session link. Discovered target fields are for operations that explicitly accept them, not extra URL fields.

Never generate `yuri://connect?...` links yourself. They carry pairing credentials and trigger a user confirmation to import a connection. Do not put tokens, passwords or secrets in any deep link.

## Opening a conversation

`sessionID` is the OpenCode session id (`ses_...`). `directory` is the absolute path of the project on the machine where the session runs. Always include it when you know it.

Desktop Yuri resolves the link against its local Hub:

1. If the session id is in that Yuri's own session index, it opens it.
2. Otherwise `directory` must belong to exactly one Remote Project already connected in that Yuri; Yuri then opens the session through that project.
3. In every other case Yuri shows a "conversation not found" notice and opens nothing. It never guesses a machine, and never connects one automatically.

A remote link requires the receiving desktop Yuri to have that machine's project associated, using the target machine's own path. After a local-index miss, equal owning paths on different connected machines are ambiguous and will not open. A unique directory match selects the remote route; it does not confirm the session exists or that its content can load. Mobile does not perform this Remote Project lookup; its session links use the connected runtime's session navigation.

## Verification

Report the link text, which branch should resolve it (local index or connected Remote Project), and the known limits above. Do not run `open "yuri://..."` to verify unless the user asks, because that moves their running Yuri window.
