# Provider connections

`ProvidersPage` preserves the shared Settings presentation. The runtime generation
and selected directory key its content lifetime, including credential drafts.
The provider sidebar has no project selector; it follows the application's current
project context without changing it. Sidebar and detail share one scoped source Query.

## Settings presentation

Provider icons use the shared `useProviderLogo` resolver. Specific brands and aliases
take precedence over the Magpie fallback: `magpie-workbuddy` keeps WorkBuddy, while
unmatched IDs containing `magpie` use the bundled Magpie SVG, copied unchanged from
the Magpie project's `internal/provider/magpie.svg`. Gateway IDs in
`magpie:<gateway>:<provider>` never determine the underlying brand. The monochrome
asset follows the existing light/dark provider-logo treatment.

Ordinary Settings navigation into Providers opens the connection-choice screen,
resetting the prior detail selection in the navigation action. Targeted Settings
search preserves its prepared selection. The choice screen renders on its first
frame; the Custom card keeps its title and two subtitle lines in a compact stack.
The collection has a compact search and a repeatable Custom entry above the source
groups. The sidebar plus opens the provider-choice screen; Custom opens the editor
directly. Both transient selections survive catalog refresh and are excluded from
persisted provider selection. The provider-choice screen lists the
actual disconnected integration catalog as a provider grid beneath a custom-entry
card. Connection details combine authentication and physical config provenance,
with confirmed provider deletion in the title toolbar. The detail defaults to a
compact connection summary and the model catalog; reconnect expands the shared
authorization panel. Go, Ollama Cloud and Cursor each expose usage credentials as
one optional row in the connection card, opening a separate Settings dialog.

`ProviderAuthFields` is the shared presentation for new connections and reconnects.
It renders actual OAuth methods as neutral chips and a provider-logo authorization
panel, plus API-key entry only when the integration advertises that method.
API-key entry is a compact labelled input row: visibility stays inside the input
and Save stays beside it, including narrow layouts. It has no full authorization-panel
padding or separate bottom action/help block. The larger centered panel belongs
only to the interactive account-authorization flow.
Selecting a different method cancels the current attempt and clears key drafts.
The existing OAuth flow still owns polling, codes, expiry and cancellation; this
component does not emulate authorization or introduce another lifecycle.

`ProviderModelRow` renders every model through the existing `ModelLogo` brand
matching and local assets, falling back to the shared stack icon. Draft and saved
catalogs use the same row grammar. Capability badges reflect available metadata.
Search is a mini name/ID input in the model toolbar, not a full-height card row;
there is no capability filter. Added models come first, with plus/minus actions.
Model name and mini limits share one compact line. Below 24rem of row width,
limits move to the name tooltip so names and capability/action controls stay usable.
For existing catalogs these actions keep the existing persisted selector preference
semantics (`hiddenModels`); they do not delete upstream models. Add all and Remove
all apply to the full catalog independent of search. Both catalogs render at most 100 matches
and show the bound when exceeded. Removal can be undone. Added models expose a
gear and name-click editor. Draft edits stay local; saved-model edits use
`ProviderModelEditor` and `PUT /api/config/providers/model`. Saved IDs are immutable.
Name, limits, tools and image input write a native model override through the
physical configuration owner, preserving routing and unrelated model fields.
Cancel never writes; errors keep the dialog for retry. Scope changes/unmount abort
requests and discard late responses. Model discovery remains the custom draft's
responsibility; existing catalogs refresh through the native provider catalog.

The custom editor combines the provider-choice back action and cancel/save controls
in one shared top action header, without a separate Custom title or back-action row.
It places name before protocol, a
right-aligned request preview and optional key visibility.
Name, protocol, URL and key share equal value-column edges through the grouped
card's `yuri-settings-equal-controls` contract, including narrow cards. The request
preview uses `SettingsRow.footer` below both columns, spanning the card's full
content width without widening the input. URL completion rules are not displayed;
normalization and the actual request-address preview remain unchanged.
Model dialogs start with ID/name and collapse limits/capabilities into
More settings. All surfaces use shared Settings/solid tokens, including narrow
layouts, and retain the Settings shell's mobile navigation owner.

`providerConnectionQueries.ts` owns the TanStack Query snapshot for active providers
and the complete integration catalog, keyed by transport, generation, and directory.
Requests use the installed official OpenCode 2 client through `opencodeClient`, with
location and cancellation signals. The add-provider picker uses integrations whose
`connections` are empty and whose IDs do not start with `mcp_`. `provider.list`
supplies active-provider-to-integration mappings; model rows continue consuming the
config store's separately assembled model catalog. A failed refresh retains the
last snapshot and exposes an error.

`providerSourceQueries.ts` shares one batch between sidebar and detail, keyed by
transport, generation and directory. It reads the Host's safe projection of the
running service's `provider.list`, `config.get` and `integration.list`; raw
credentials are never requested. File sources include their physical paths;
pathless documents are labelled built-in/in-memory configuration. Providers with
no contributing document are labelled runtime injection (such as plugins), not
"no active source". The native API has no provider-to-plugin ownership mapping, so
the UI does not infer plugin names from provider IDs. Failed refreshes retain the
last source snapshot and display the failure. Successful create/auth/delete flows
refresh this scoped resource.

Provider deletion first reads scoped integration credential IDs when an integration
exists. The delete button and confirmation are disabled while provenance is pending
or failed, when an environment connection remains, or when neither a physical
configuration nor an independently removable credential exists. The disabled
button's focusable wrapper uses a not-allowed cursor and the shared tooltip
(zero-delay hover/focus or touch long-press), without an inline explanation block.
Its concise copy directs users to environment/plugin/runtime management and
offers **Remove all** below as a model-selector hiding alternative, not provider
deletion. The mutation rechecks the current integration for environment connections
before changing files or credentials; disabling the button is not the only guard.
For eligible providers, deletion
deletes all provider configuration occurrences via `scope=config`, then
removes credentials through the official API. Keyless custom providers do not need
an integration. Each physical file write is atomic, but multi-file/credential
deletion is not transactional: failure retains the dialog and offers retry. A
runtime-only provider with nothing independently removable reports its source
management requirement, never successful deletion. Success also requires the
refreshed authoritative provider list to omit the deleted ID; removing a plugin's
configuration override alone cannot masquerade as removing its registration.
No service restart is requested.

## Custom provider creation

The first sidebar entry and first add-provider choice are **Custom**. That entry
works even while the integration catalog is unavailable. `CustomProviderForm`
uses the shared protocol Select and supports multiple explicit model IDs, display
names, optional token limits, tools and image input. Saved custom providers appear
in the ordinary authoritative provider/model catalog; there is no second model store.
**Custom** is a repeatable creation entry, not a singleton provider. Each new form
receives a host-allocated ID from its Provider Name: normalized lowercase words
joined with hyphens, with numeric suffixes for saved/runtime/integration collisions.
The draft discovery identity remains independent of name edits. Saving opens that provider; returning to
the creation entry starts a fresh draft. Saved sidebar rows and detail titles use
the configured **Provider name**, not the generic Custom label or protocol name.
Providers may share a protocol, endpoint, model IDs, or even a display name without
overwriting one another; credentials and configuration remain keyed by provider ID.
The model section is one compact searchable list, with configured models first.
Both the custom-provider and existing-provider model filters use the shared
`Input bordered` option for a faint persistent edge. Hover/focus keeps the shared
background feedback without adding a focus ring or outline.
Configured rows show their actual image-input/tool capabilities as theme-token
pills, an explicit settings-gear edit action, and a minus remove action, not a
selection checkmark. Clicking the model name still opens editing.
Toolbar actions are self-describing: no idle instruction or explanatory subtitle
is rendered. Discovery-empty/error feedback and submit-time validation remain visible.
The **+** action beside **Sync models** opens `CustomProviderModelDialog`; selecting
an added row edits it in that same dialog. Dialog drafts apply locally on confirmation
and are discarded on cancel. Its form is a React sibling of the provider form so
portal submit events cannot accidentally create the provider. Duplicate IDs and
invalid limits remain validation errors; removing the last model is allowed, but
provider creation requires at least one model.
The editor uses the ordinary opaque `DialogContent` and solid shared actions.
Its portaled root establishes the shared Settings workspace scope so grouped-card,
row geometry and input tokens do not depend on inheriting the page's DOM ancestry.
Custom-provider and existing-provider API-key fields place their show/hide action
in `Input.endAdornment`, inside the input's right edge. The action remains a
labelled `type="button"` toggle with `aria-pressed`, shares the input's disabled
state, and never submits or changes the credential draft. Key-save stays outside.

`packages/web/shared/custom-provider-protocol.js` is the browser-safe, shared protocol
and URL owner. Like Cherry Studio, trailing `/` is normalized, missing `/v1` (Gemini:
`/v1beta`) is inferred, existing version paths are retained, and trailing `#` suppresses
version inference. A matching full Chat/Responses/Messages endpoint ending in `#`
is split into its native base URL. The dynamic preview shows the actual native route
(Gemini streams through `:streamGenerateContent?alt=sse`), including the entered model.
The normalized base, never Cherry markers, is persisted in `settings.baseURL`.

Draft model discovery uses a transient runtime/directory/draft/revision Query through
`POST /api/config/providers/custom/models`. Address, key or protocol edits cancel the
previous read immediately; 600 ms of settled input triggers discovery. Credentials
never enter Query keys/data and `gcTime: 0` releases draft request closures on exit.
Manual refresh preserves a prior successful snapshot on failure. Selecting a result
adds a configured row; failed/empty discovery never erases manual entries.
**Add all** adds the complete discovery snapshot, independent of search and the
visible row limit, in one state update. It deduplicates by ID and preserves existing
manual names, limits and capabilities. **Remove all** clears every configured draft
model in one update, including manual models, while retaining discovery results.
Search considers both all configured models
and remaining discovered models, but renders at most 100 matches (tested with 2,000
models before and after bulk addition), without a request per keystroke or an inline
form per selected model.

Creation uses `POST /api/config/providers/custom`, a Yuri-owned file mutation because
the official V2 config update API only changes the shell. It writes native
`providers[id].{name,package,settings,models}` and validates with the installed
`@opencode/schema/config/provider`. API keys go only to the host-side official
credential API, never JSONC, logs or responses. See the host module for rollback and
physical-file behavior. No process restart/reload is requested. Successful writes
clear the transient key, refresh the shared model catalog, and select the returned
provider ID once that catalog can render its detail. The file watcher gets up to
five catalog reads with abortable 250ms gaps; no config/credential write is repeated.
Connection/source metadata refreshes independently; a lagging
`provider.list` must not block navigation or produce a model-unavailable error.
If the shared refresh fails, a neutral saved-state status allows Retry without repeating writes.
Directory/runtime changes or unmount abort requests and reject late completions.
Web/Electron/mobile share the Host routes; VS Code bridges to the same host helpers.

API-key connection and disconnect mutations capture directory, transport identity,
runtime generation, and the mounted content's abortable lifetime. Every awaited
stage checks that capture before refreshing, notifying, selecting, or clearing busy
state. Key connection and integration lookup carry explicit `location`. OpenCode
2.0.12's `credential.remove` is runtime-global and accepts only `credentialID`;
disconnect takes those IDs from the scoped integration lookup and passes the
lifetime's AbortSignal to deletion. Successful mutations refresh the current
connection Query after scoped provider/model catalog refresh. These mutations
never call `/api/config/reload`, `location.reload`, or the service lifecycle.
Global credential and location provider/model events also refresh other loaded
directories through `sync/config-live-refresh.ts`. A complete empty catalog after
an explicit credential/domain refresh may clear the last disconnected provider;
bootstrap-empty and failed/partial reads retain their existing safeguards. Key connection
selects the refreshed provider's actual ID through its `integrationID` mapping.

`providerOAuth.ts` owns one attempt and its request/timer lifecycle:

- `auto` immediately reads `integration.oauth.status`, then polls pending attempts
  every 1.5 seconds. Only `complete` triggers provider configuration/catalog refresh.
- `code` sends `integration.oauth.complete` after a non-empty pasted code.
- Server failure, expiry, and transport failure clear local waiting state and show
  localized generic feedback. Raw OAuth errors and authorization URLs are excluded
  from diagnostic logs. URL/code display is transient, cleared on completion or exit.
- Startup has a 30-second bound; waiting uses the earlier of server expiry and a
  ten-minute client ceiling, including stalled status requests.
- Cancel, provider/directory navigation, replacement, and unmount abort requests,
  clear timers, and best-effort cancel the old attempt. A late connect response is
  cancelled when its original runtime is still current. Once runtime generation
  changes, no cancellation is sent through the newly active transport; the old
  server owns expiry. Stale callbacks cannot refresh or select in the new UI scope.
  Directory validity is checked at response time, including the window before
  React's unmount cleanup executes.
- Claude Code owns opening its own sign-in browser; its informational URL remains
  available for explicit opening.

OpenCode Go sign-in uses `getSignInIntegrationId`: `opencode-go` maps to the `opencode` Console integration. Go's own integration only accepts a service-account key, so Console OAuth never starts against `opencode-go`. An OAuth credential on `opencode` means the Go card already has Console credentials. Workspace ID and auth cookie saves stay on the quota credential route.

`QuotaCredentials` owns only optional usage credentials, never another OAuth flow.
`quotaCredentialQueries` caches the safe configured/workspace projection by runtime,
generation and provider; usage credentials are host-global, not directory config.
Its dialog clears secrets on cancel/success and exposes explicit save-and-validate,
validation, Cursor import and confirmed deletion. Failed reads offer Retry rather
than claiming unconfigured; failed writes preserve the last status. Pending reads
are cancelled before mutation cache updates. Mutations capture runtime/directory
and lifetime, suppressing stale notifications/cache changes after navigation.

All shared runtimes use the same SDK state machine and `openExternalUrl` boundary.
Focused component tests cover catalog selection, pending-to-complete, pasted codes,
failure, expiry, timeouts, cancellation, unmount, stale connect/status responses,
provider changes, runtime/directory changes, API-key/disconnect late responses,
scoped cache refresh, ID mapping, and refresh failure. Browser verification against
a real isolated server is separate from mocked component success assertions;
third-party login/consent and credential persistence require a human authorization.
