# Collections owner integration (2026-11-08)

## Main / settings owner contract

`settings-collections.tsx` exports `SettingsCollectionRoute`, `SettingsCollectionDraft`, `SettingsCollectionCallbacks`, and `SettingsCollectionNavigation`.

- Preserve the optional `collectionDraft: { editor: Row; config: Row; jsonc?: CollectionJSONCSource }` on route objects, pass it unchanged to `SettingsCollection`. It is an ephemeral local copy draft, never persisted navigation/settings. `editor.name` is the proposed unused copy name; `config` is the complete captured source definition. `jsonc.raw` contains only the selected definition and its comments, not unrelated credentials from the config document. Opening/cancelling this route must not POST/PATCH/DELETE/PUT.
- Pass `onCollectionDirectory(directory, route)` through `SettingsPage`. Replace the current collection route using exactly the supplied `directory`, including explicit `undefined` for Global. Forward its `entity/create/target/collectionDraft` as well. The collection owner confirms dirty editor changes before calling it. Do not apply the ordinary inherited-directory fallback on this callback. Do not select a first/recent project. Rows, editors, catalog requests and project writes inherit this captured directory; explicitly global configuration routes remain global on the same captured Host operation.
- Pass `onCollectionNavigation({ blocked, back })`. Use the same NavPage `popOnBack={!blocked}`, `popOnSwipe={!blocked}`, `onBackPress` contract as `SettingsProjectsPage`. `back()` owns the discard confirmation and calls the existing `onBack` only after acceptance. Replacing the owning route releases this registration.
- Search emits the existing `{page, target}` contract. `SettingsCollection` itself calls `prepareCollectionSearchTarget(page, target)` before loading, opens an unsaved draft, and prepares MCP local/remote visibility. Preserve `target` when routing; do not resolve it to a page-only action. Native field positioning uses measured View/Scroll coordinates after layout.

## Pure VM loader contract for Voice owner

Keep the production `settings-collections-core` and `settings-protocol` imports. Add these module mappings when evaluating `settings-collections.tsx`:

```ts
import * as collectionOperations from './settings-collection-operations';
import * as collectionScope from './settings-collection-scope';
import * as collectionJSONC from './settings-collection-jsonc';
import * as settingsSearch from './settings-search-core';

// Real operation/search functions; do not replace with empty callbacks.
'./settings-collection-operations': collectionOperations,
'./settings-collection-scope': collectionScope,
'./settings-collection-jsonc': collectionJSONC,
'./settings-search-core': settingsSearch,
// Inert JSX component ports, consistent with the existing callback-only harness.
'./settings-collection-kv': { SettingsCollectionKV: 'SettingsCollectionKV' },
'./settings-collection-picker': { SettingsCollectionPicker: 'SettingsCollectionPicker' },
'./settings-collection-plugins': { SettingsCollectionPlugins: 'SettingsCollectionPlugins' },
'./settings-collection-directory': { SettingsCollectionDirectory: 'SettingsCollectionDirectory' },
'./native-sheet': { NativeSheet: 'Sheet' },
```

The collection page has no initial project-list request. Opening its project picker reads `/api/config/settings` through its captured operation. Models/Agents are child picker owners; inert JSX must not execute them as replacement renderers. Existing page save and scope assertions remain intact.

## Validation boundary

This owner runs source typechecking and focused pure Vitest tests only. No NSH engine, device, real Host, Git/GitHub, dependency installation/change or paid service is authorized. Main owns the serialized full suite and engine reruns. Pure callback tests do not establish UIKit field positioning, Sheet presentation, keyboard focus, dirty swipe-back or actual Host behavior.

## Implemented operations and recovery

### Existing Agent scope moves

`settings-collection-scope.ts` owns `draft → write-unknown → copied → cleanup/delete-unknown → done`. It captures current Markdown and JSONC sources, checks the exact target path and rejects a pre-existing target. A plain Markdown-to-project move keeps every byte; merged sources/edited drafts preserve unknown, nested, null and false field values. JSON `system` text becomes the native Markdown body. Existing built-in Agents have no old definition to remove and retain the ordinary scoped override PATCH behavior.

- Project target: use the current metadata's `projectMd.path`, write the complete Markdown via existing `POST /api/fs/write?directory=captured`, verify exact bytes, then remove only the captured old scope via `DELETE /api/config/agents/:name {scope:from}`.
- Global target: use `GET/PUT /api/config/global/opencode` and insert a complete native Agent entry while preserving all unrelated JSONC text. A Markdown body becomes the native JSON `system` value. A conflicting existing frontmatter `system` plus a different body must be resolved explicitly in the editor before moving; the operation never drops one silently.
- `unknown` target write recovery is read-only. After ACK, failed GET never repeats the write or rolls back the target. An unknown DELETE first checks the original exact source; only a subsequent explicit cleanup action can remove a source authoritatively still present. A confirmed DELETE is never replayed after a failed read.
- Source edits, target edits, newly exposed uncaptured lower-layer definitions and identity conflicts preserve both definitions and surface a recoverable failure instead of deleting unreviewed data. The pending journal freezes the captured editor and directory, participates in dirty Back handling, and resumes only after an explicit same-Host operation replacement.
- Before deleting a captured JSON source, a fresh metadata response must explicitly report no Markdown in the entire old scope (`projectMd`/`userMd`). This checks the resolver's plural, legacy and grouped-file precedence, rather than only the previously captured file path. If deleting the first Markdown exposes an uncaptured legacy Markdown, cleanup stops before a second DELETE and retains that file, JSON and the confirmed destination.

Current upstream evidence: `agents.js` `writeNativeAgent`/`updateAgent` write only the selected target, and `deleteAgent` removes one exact requested-scope source at a time. `config-entity-routes.js` registers metadata/config GET, scoped PATCH/DELETE, and global raw GET/PUT; it has no atomic cross-scope move or durable operation receipt. `fs/routes.js` authenticates unrestricted reads but restricts fs.write to workspace/Yuri roots, so global writes must not change the captured directory to bypass that boundary. Neither write route exposes compare-and-swap against another client's simultaneous write. This implementation checks captured identities and explicit phases; it does not claim cross-client atomicity unsupported by those routes.

### Command JSONC copies

`settings-collection-jsonc.ts` reads JSONC offsets without a new dependency. It accepts BOM, line/block comments, trailing commas, escaped strings and nested unknown values. The copied value and attached leading comments are sliced from the captured original; edited fields replace only their value spans. At save, it reads the latest destination and appends the new entry while preserving the original entry and every unrelated byte. Source metadata rejects an intervening Markdown/JSON name collision before writing.

The UI chooses the canonical global raw route for user scope. For project scope, it uses the captured source file when it belongs to that workspace, or the Host's documented new-project JSONC location (`config-files.js` `paths.projectPath`: `.opencode/opencode.jsonc`) in the explicitly selected directory. After dispatch, `unknown/confirmed` retries only GET the saved entry. No copy/cancel action writes until Save.

### Plugin batch receipt reconciliation

`settings-collection-plugins-core.ts` retains one receipt per entry and isolates partial failures. Refresh invokes `reconcile` with GET only; there is no update replay in this path.

- A pinned rewrite verifies the new spec, original sourcePath/scope/options, and absence of the old entry. It deliberately accepts the new ID: `plugins.js:listPluginEntries` derives IDs from `scope:spec`, so a successful spec rewrite changes the ID.
- A runtime update requires a captured nonblank entry ID, sourcePath and user/project scope. It verifies that exact entry's ID/spec/path/scope/options before reading the runtime package target and its captured desired version, or an actual version change from the captured baseline with no outdated/updating flag. Changed options or missing source identity keep the receipt unknown even when the runtime version advances. Another package/version/source cannot confirm it.
- Unconfirmed receipts reserve both original and rewritten identities, so a list refresh cannot sneak in a second update under the new ID. Missing version/identity authority leaves the receipt unknown and keeps Refresh available; other entries can still finish. ACKed entries remain complete through later inventory-read failures.

These are source/pure-operation guarantees. The UIKit and real-Host validations above remain with main and the independent oracle.

## Stable-point verification

2026-11-08, initial stable point before the oracle follow-up:

- `bunx tsc --noEmit -p packages/nsh/tsconfig.json`: passed; no production files excluded and no `any` cast used to bypass narrowing.
- The nine focused collection/scope/JSONC/plugin/request-scope/locale/type-boundary Vitest files: 68 tests passed.
- `settings-navigation-production.test.ts` filtered to `hardware shortcut driver contracts|settings navigation strict production Host`: 40 passed, 6 engine cases not run.
- No engine, device, real Host, Git/GitHub, paid service, dependency installation/change, full workspace suite, iOS build or dead-code run by this owner. Main retains the serialized build/full-suite/dead-code and independent runtime/oracle checks.

Oracle follow-up: two plural/legacy-Markdown-plus-JSON regressions and four runtime options/missing-identity regressions first failed on the production core. After the fixes, the four focused scope/plugin/request-scope/JSONC files passed all 50 tests, and the complete production graph TypeScript check passed again. Tests assert only the first captured Markdown is deleted, retries never issue the second DELETE, unknown plugin recovery uses GET only, and update dispatch count stays one.
