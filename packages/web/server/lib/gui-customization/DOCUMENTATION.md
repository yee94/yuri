# Built-in Yuri customization skill

`session-skill.js` stages the shipped `skill/SKILL.md` and its references in
an application-owned, content-fingerprinted `session-skills` directory. Only a
short discovery pointer enters `session.instructions.entry` under
`yuri.customization`. Agents load the skill and matching references on demand;
no global OpenCode config, installed user skills, project files or old sessions
are modified.

References are organized by capability: window APIs, appearance, UI surfaces, plugin styles, global pages, work-status widgets, icons,
file parsing/previews, preview actions/exports, and package workflow. Host contracts
and verification criteria are separate from illustrative templates and case
studies. Runmark and Eficy remain integration references; their service protocols,
renderers and compatibility choices are not requirements for unrelated plugins.

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

The feature adds no HTTP resource endpoint, credential or native privilege.
Package publishing includes the entire web `server` directory, so the Markdown
resources ship with the backend and resolve relative to this module in packaged
Electron as well as web installs. Fingerprinted resources remain readable by old
sessions across backend upgrades.

## Validation

`session-skill.test.js` exercises staging, complete resource availability, short
per-session pointers, managed admission/rollback/adopted sessions and external
ownership. Shared-service admission is covered by
`../scheduled-tasks/session-skill.test.js`. The UI test
`packages/ui/src/lib/gui-plugins/skill-examples.test.ts` transpiles the shipped
global-page and custom-file templates and runs them through the real GUI host,
plugin context, navigation, file read, mount and cleanup. These are contract
fixtures, not live Runmark/Eficy backend tests.
