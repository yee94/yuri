# Built-in Yuri customization skill

`session-skill.js` stages the shipped `skill/SKILL.md` and its references in
an application-owned, content-fingerprinted `session-skills` directory. Only a
short discovery pointer enters `session.instructions.entry` under
`yuri.customization`. Agents load the skill and matching references on demand;
no global OpenCode config, installed user skills, project files or old sessions
are modified.

Interactive Yuri contacts reuse this same shipped entry and references through
the assistant-only pointer in `../assistants/builtin-skills.js`. Their pi tools
run on the Host, so the pointer names the package-local resource directly rather
than staging a Session instruction. It advertises no bound desktop helper and
grants no SSH/config-sync/Relay capability. Read-only background reviews omit it.

References are organized by capability: project registration, window APIs, appearance, UI surfaces, plugin styles, global pages, work-status widgets, icons,
file parsing/previews, preview actions/exports, and package workflow. Host contracts
and verification criteria are separate from illustrative templates and case
studies. Runmark and Eficy remain integration references; their service protocols,
renderers and compatibility choices are not requirements for unrelated plugins.

`references/projects.md` routes project registration through the bound projects
API helper, before plugin authoring. Shared-service admission supplies its binding
independently of Electron's remote-connections adapter. `projects-client.mjs` is
staged as `projects.mjs`; it and the remote helper share the staged
`session-skill-command.mjs` command formatter. Only bound helpers are staged, and
each resource combination has its own content fingerprint. Existing sessions keep
their immutable staged references until a new session is admitted. Contacts use
their own granted `yuri.projects` tools, not this session binding.

`projects.js` owns `POST /api/yuri/session-skills/projects` (`describe`, `list`,
`add`). The global gate and route require the existing loopback service credential,
no browser Origin, shared-service ownership and the session's admitted Host origin.
The bridge reuses `projects/registry.js`, just like the UI directory API and contact
tools: strict reads, canonical path deduplication, serialized persistence and
existing project-order SSE notifications remain with their owners. Registration
preserves an existing active selection and returns only `{project, created}` after
persistence, never settings/credentials. List errors remain errors. There is no
cloning, directory creation, conversation creation or desktop window navigation.
Web/Electron/connected-mobile shared-service sessions operate on their bound Host;
private/external OpenCode and standalone VS Code have no session helper admission.

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

Package publishing includes the entire web `server` directory, so the Markdown
resources ship with the backend and resolve relative to this module in packaged
Electron as well as web installs. Fingerprinted resources remain readable by old
sessions across backend upgrades.

## Validation

`projects.test.js` exercises project bridge validation, authentication, binding,
persisted idempotent registration and failure receipts. Shared-service admission
tests execute the exact staged project helper through the real global auth gate.
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
