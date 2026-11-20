# Built-in Yuri customization skill

`session-skill.js` stages the shipped `skill/SKILL.md` and its references in
an application-owned, content-fingerprinted `session-skills` directory. Only a
short discovery pointer enters `session.instructions.entry` under
`yuri.customization`. Agents load the skill and matching references on demand;
no global OpenCode config, installed user skills, project files or old sessions
are modified.

`skill/references/deep-links.md` is the on-demand reference for `yuri://` links
(session, new-session, open-project, host, settings). It mirrors the vocabulary in
`packages/ui/src/apps/deepLinks.ts` and the desktop session-link resolution in
`packages/ui/src/sync/DOCUMENTATION.md`; update it when either changes. It is
navigation guidance only and adds no helper or authorization.

The discovery pointers advertise capability categories, not individual scenarios,
operation names or API recipes. The skill routes to the relevant reference; a
bound helper's `describe` is authoritative for the current caller. The skill
ends with the open-source repository as a research fallback for undocumented
capabilities, not as an alternative to runtime authorization.
`references/projects.md#resource-identity-and-scope`
owns the common discovery/identity guidance; `references/deep-links.md` owns the
receiving client's supported URL fields and prerequisites. Agents retain complete
remote targets for resource operations while emitting only fields accepted by the
navigation protocol. Existing instance discovery/binding does not imply support for
identity-scoped session URLs; this skill update adds neither a self-identity helper
nor a new deep-link parameter.

Interactive Yuri contacts consume this same skill, staged resources and helpers
through the assistant-only pointer in `../assistants/builtin-skills.js`, so a
contact and an OpenCode Session have the same capability set. The Host resolves
`createCustomizationSkillInstaller(...).resolve({ assistantID }, bindings)` per turn
(`feature-routes-runtime.js`): the pointer names the staged `SKILL.md` and the bound
`projects.mjs` / `remote-connections.mjs` describe commands, which the contact runs
with its pi `bash` tool. The remote helper is bound only when the Electron adapter is
present. Without `bash`, a resolved binding, a shared service or a readable
registration, the pointer falls back to the shipped file with no helper and the
SSH/config-sync/Relay branch stays unavailable. Read-only background reviews omit it.

Both bridge routes accept exactly one caller: `{sessionID}` (admission-bound Session
metadata) or `{assistantID}` (a live, non-tombstoned contact checked through
`hasAssistant`). `skill-caller.js` owns that parsing and binding check; a body with
both or neither is `invalid_input`. Loopback, no Origin and the shared-service
credential still gate every call.

References are organized by capability: project registration, window APIs, appearance, UI surfaces, plugin styles, global pages, work-status widgets, icons,
file parsing/previews, preview actions/exports, and package workflow. Host contracts
and verification criteria are separate from illustrative templates and case
studies. Runmark and Eficy remain integration references; their service protocols,
renderers and compatibility choices are not requirements for unrelated plugins.

`references/projects.md` routes project registration and local removal through the bound projects
API helper, before plugin authoring. Shared-service admission supplies its binding
independently of Electron's remote-connections adapter. `projects-client.mjs` is
staged as `projects.mjs`; it and the remote helper share the staged
`session-skill-command.mjs` command formatter. Only bound helpers are staged, and
each resource combination has its own content fingerprint. Existing sessions keep
their immutable staged references until a new session is admitted. Contacts keep
their granted `yuri.projects` `register_project` tool for the assign flow and also
reach every other operation through the same helper, bound to their `assistantID`.

`projects.js` owns `POST /api/yuri/session-skills/projects` (`describe`, `list`,
`add`, `remove`, `task-sessions`, `session-state`, `settle-session`, `unsettle-session`, `archive-session`, `unarchive-session`, `remote-hosts`, `add-remote`, `remote-projects`, `sessions`, `read-session`, `create-session`, `prompt-session`, `archive-remote-session`, `unarchive-remote-session`). `projects-remote.js` uses the injected `remoteHostGateway` and its immutable task leases; discovery returns authenticated `{hubId,hostId,instanceId}` targets, and explicit targets never fall back to local. `remote-hosts` includes authorized machines with no associated project, reports per-machine failures and releases each probe. `add-remote` uses `gateway.registerProject`, shared with the UI: the target validates/canonicalizes and registers the directory before the Hub saves a deduplicated reference and broadcasts project-order invalidation. A Hub write failure leaves the remote project intact; retrying the same target/path completes association. Paths are never resolved on the Hub filesystem. Lease cleanup runs on every outcome. Remote SDK requests preserve generated request data through the lease; bounded message reads use the existing Host turn-page route. No remote bodies are persisted on Hub. Session creation/prompt require stable caller IDs for ambiguous-result inspection, not automatic replay. This capability neither uses nor grants the desktop SSH helper. The global gate and route require the existing loopback service credential,
no browser Origin, shared-service ownership and the session's admitted Host origin.
The bridge reuses `projects/registry.js`, just like the UI directory API and contact
tools: strict reads, canonical path deduplication, serialized persistence and
existing project-order SSE notifications remain with their owners. Registration
preserves an existing active selection and returns only `{project, created}` after
persistence, never settings/credentials. Removal returns `{projectId, removed:true}`
after persistence; an absent ID is 404. It updates the existing Assistant allowed
roots from the saved registry and does not delete files, sessions, tasks or remote
project references. List errors remain errors. There is no
cloning, directory creation or desktop window navigation. Remote conversation creation is explicit and separate from local registration.
Web/Electron/connected-mobile shared-service sessions operate on their bound Host;
private/external OpenCode and standalone VS Code have no session helper admission.
Remote SDK calls share `remote-hosts/task-client.js`, so the target proxy owns
execution admission even when the Hub's own OpenCode is unavailable. Reads use a
25-second operation budget; explicit create/prompt use 300 seconds (the bound
client waits five seconds longer for the result). Caller disconnect cancels and
releases the task lease; uncertain writes are inspected by their stable IDs before
any retry.

`projects-lifecycle.js` owns bound-Host task/session archive operations.
`task-view` merges the local rows (`task-rows`, internal) with the Hub-synced remote Host index (`listRemoteTaskRows`: all project and worktree directories; remote `settled` means archived) behind one pager. `task-sessions` is the local-only variant and pages the current index metadata (50 rows, newest activity first across directories, optional boolean `settled` filter applied before paging, rows carry the live `status`), using the same committed
Host archive filter as the UI; it explicitly distinguishes an exhausted index from
complete upstream history. It exposes no messages or raw metadata.
Verification uses `session-state`, which exposes Host archive authority even after
an archived row leaves the index; nullable task fields do not imply live membership.
Task archive (`settle-session`) and restore (`unsettle-session`) reuse index writers and the normal
revision publisher, validating existing membership before writing. Session archive
and restore reuse `sessionArchiveService.setArchive`, including partial index-repair
receipts and sanitized errors. Neither path needs a UI password, deletes content,
changes another runtime partition or bypasses the existing session binding.
Task projection is not live UI membership: pins and running/pending requests retain
their existing precedence. Remote targets are rejected by these local operations.
New admitted sessions get the updated fingerprinted skill and helper after the Host
is upgraded; existing staged helpers remain immutable, not silently overwritten.

`references/plugin-styles.md` inventories existing host CSS variables for plugin-owned
Solid/DOM content, including colors, typography, geometry, controls and optional
theme config. The workflow routes every plugin view through this reference. Visual
consistency is authoring guidance through scoped CSS and SVG, not a React/Solid
component bridge or a host-provided UI component library. The host's `ctx.ui` remains
unsupported; plugin markup, layout and behavior remain plugin-owned.

`references/icons.md` distinguishes the upstream generated `IconName` union from
Yuri's actual titlebar/sidebar renderer, lists their verified shared names and
aliases, and separates entry icons from Settings artwork, file icons and branding.
It documents Yuri's direct `TitlebarItem.icon` SVG/data-URI string extension,
static-SVG validation, image fallback, SDK typing and portability boundary.
It also documents same-document SVG symbol references, common sprite keys and the
current DOM/version boundary without exposing the React Icon component. Update its
shared-name list when the renderer or supported SDK catalog changes.

`references/ui-surfaces.md` is the shipped structural/style map for plugin authors
without a source checkout. It covers shell, sidebar, header, transcript, composer,
preview, Settings, overlays, tokens/cascade and native transparency boundaries.
The entry and appearance reference route existing-block CSS work there first.
DOM hooks are version-sensitive implementation guidance, not new public APIs.
When these owners change, update their map and recipes alongside the owning docs.

The authoring workflow defaults to directly written `gui-experimental.cjs` with
host-provided modules and inline assets. Local edits use the existing revision
watcher; compilation is only an optional path for typed/JSX or bundled sources.

`references/work-status.md` documents `yuri.work-status`, its displayed-session
context, registration order, mount cancellation, desktop placements and Git
snapshot limitations. Its complete CJS example uses the existing Solid runtime,
CSS variables and SVG symbols; `skill-examples.test.ts` executes it against the
real host. The reference is included in the immutable staged resource inventory.

## Admission ownership

- Shared-service sessions: the existing scheduled-task admission route installs
  this instruction after its authenticated scheduled-task preflight. Both must
  finish before returning the session. Existing rollback semantics apply.
- Managed local OpenCode: `registerCustomizationSessionSkill` owns session create
  and this instruction only, before the generic proxy. A failed installation
  removes a newly allocated session; an explicitly supplied/adopted session is
  retained. If removal fails, the response includes the retained session ID.
- External OpenCode and VS Code's independent extension-host session creation:
  no local-file pointer is injected, because the agent is not proven to share
  this Host's filesystem. GUI plugin contracts themselves remain available on
  their supported clients. Existing sessions do not gain the pointer retroactively.

## Remote connection capability

The same skill routes SSH/config-sync/Relay requests to `references/remote-connections.md`.
For shared-service sessions only, an injected Electron `remoteConnectionsAdapter`
adds a bound helper command to the existing pointer. The immutable inventory also
stages `remote-connections-client.mjs` as `remote-connections.mjs` only for bound
sessions; no credential is written into the instructions or helper. Bound and
unbound resource sets have separate content fingerprints and preparation caches.
Other admission modes retain the reference, but no executable helper or local
desktop command. A staged script or another capability's binding is not admission.
The pointer states this unavailable branch explicitly. The connection reference
stops on a missing/denied helper instead of falling back to settings/credential
reads, direct HTTP or source-derived access; successful fallback is not evidence
that the session capability worked. This is authoring guidance, not an OS sandbox
for agents that already have local shell access.
The helper marks HTTP 401/403/501 and unusable bindings as `terminal: true`,
with a stop/re-admission receipt rather than recommending `list` after an auth
failure. Other failures return operation-specific recovery. All remote operations
share the same gate; successful `describe` is the workflow's entry condition.

`remote-connections.js` owns `/api/yuri/session-skills/remote-connections`.
The global API gate and route both require loopback POST, no Origin and the
shared service Basic credential. The route re-reads the session's admission-owned
`metadata.yuri.scheduledTaskSkill.hostOrigin` binding before dispatch. This reuses
the shared-service admission identity, not scheduled-task domain operations.
Browser bearer/Relay clients cannot use the bridge. There is no generic IPC,
shell, filesystem, credential-read or settings-write operation. Requests have
bounded allowlisted input; results contain metadata and explicit one-time pairing
links, never long-lived credentials or raw upstream errors. Pairing responses and
all bridge responses use `Cache-Control: no-store`.

Electron owns atomic SSH upsert and per-target asynchronous setup; the Host route
is a narrow dispatcher. Agent callers start each target and poll `list`, so a
short tool deadline does not strand other targets. Repeated active requests join
the target operation. Saved instances survive restart; setup receipts do not.
The pairing operation calls the existing authenticated Host pairing API, never
writes pairing stores or grants SSH-only connections Relay provenance.
New session-created managed SSH entries use the same `download_release` default
as the UI. Existing saved installation choices remain unchanged. Linux portable
bootstrap and release alignment belong to Electron's SSH manager; the skill only
submits the destination and reports connection/sync/gateway evidence separately.

Package publishing includes the entire web `server` directory, so the Markdown
resources ship with the backend and resolve relative to this module in packaged
Electron as well as web installs. Fingerprinted resources remain readable by old
sessions across backend upgrades.

## Validation

`projects.test.js` exercises project bridge validation, authentication, binding,
persisted idempotent registration, local removal and failure receipts. Shared-service admission
tests execute the exact staged project helper through the real global auth gate.
`projects-lifecycle.test.js` executes the staged lifecycle commands through that
gate with UI password protection enabled, real temporary SQLite/metadata stores
and the existing archive service. It verifies discovery/pagination, settle and
archive round trips, missing IDs, binding/runtime rejection, write/read failures,
revision publication and sanitized partial-repair receipts without production data.
`session-skill.test.js` exercises staging, complete resource availability, short
per-session pointers, managed admission/rollback/adopted sessions and external
ownership. Shared-service admission is covered by
`../scheduled-tasks/session-skill.test.js`, including execution of the exact
staged remote helper through the real API auth gate and rejection after a Host
binding change. `remote-connections.test.js` covers unsupported runtimes and
origin rejection. Electron's `session-connections.test.mjs` covers per-target
partial failure, active-operation reuse, source selection and pairing payloads;
Magpie gateway and HTTP tests live in `../config-sync/`. The UI test
`packages/ui/src/lib/gui-plugins/skill-examples.test.ts` transpiles the shipped
global-page and custom-file templates and runs them through the real GUI host,
plugin context, navigation, file read, mount and cleanup. These are contract
fixtures, not live Runmark/Eficy backend tests.
