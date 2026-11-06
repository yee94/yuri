# Cross-agent history import

This Host-owned module reads source histories and project instruction text,
normalizes them, and writes new conversations through official OpenCode
`session.import`. It does not write OpenCode databases or run historical prompts.
Agent Connect reader/normalization adaptations use fixed commit
`42287c14a8fd381bc7ef7a96076a5cba5b4d75f6`; its MIT notice is in
`AGENT_CONNECT_LICENSE`. No Agent Connect process or new dependency is installed.

## Ownership and routes

- `sources.js`: default/custom Host roots, bounded traversal, JSONL/Zstandard,
  source identities and revision fingerprints.
- `native.js`: current OpenCode instance metadata inventory and bounded message
  excerpts; existing sessions are attached in place, never copied.
- `installations.js`: connected-Host executable/application detection, without
  launching agents. Scan returns per-source `true`, `false` (not detected), or
  `null` (unknown); leftover history directories are not installation evidence.
  Installation status never filters readable histories or authorizes writes.
- `sqlite.js`: Cursor editor KV and CLI protobuf/blob readers, using private
  DB+WAL snapshots. Original databases and SHM are never opened by SQLite.
- `events.js`: active transcript normalization and native transfer projection.
- `settings.js`: project-only rule/skill plans, conflicts, fingerprints, backups
  and JSONC-preserving writes through the existing config owner.
- `service.js`: scan/preview lifetimes, explicit confirmation, parent ordering,
  idempotency, cancellation and independent-item failures.
- `store.js`: SQLite job/receipt persistence; no transcript or rule content.
- `targets.js`: read-only canonical destination resolution, then confirmed missing-directory creation and revalidation.
- `routes.js`: authenticated, no-store HTTP boundary registered before the proxy.

POST `scan`, `imported`, `preview`, `start`, `resume`, `dismiss`, `cancel` and GET `job`, `jobs` live under
`/api/yuri/history-import/`. The existing Host UI/client gate authenticates them;
URL-token authentication is not accepted here. Plans and jobs additionally belong
to the authenticated client/owner and upstream runtime identity. Start requires
`confirm: true`; the same plan returns the same job on retry. Scans/plans expire
after 30 minutes and are bounded to eight retained entries each. A Host serializes
imports; closing the UI does not cancel confirmed work. Cancellation is
cooperative between items, not a rollback of already committed data.

Web, Electron, hosted mobile and Capacitor read files on the **connected Host**,
never on the browser/phone. There is no upload flow. Standalone VS Code returns
501 `history_import_unsupported` instead of forwarding these routes to OpenCode.
The setup tour sends `start({ sources, directory, confirm: true })` on “Next”.
It immediately accepts a Host-owned job; full discovery, per-item validation and
fingerprint-bound planning run in the background, without another confirmation page.
Settings conflicts keep existing files. The explicit `planID` start API remains
available with keep-both/replace decisions. Closing a client does not cancel either flow.
`progress` describes `scanning`, `validating` or `importing` with phase-local
`completed`/`total`; zero total means unknown, not 0% progress. The receipt total
is finalized after planning, including scan/validation failures. An additive SQLite
column migration persists progress. Restart marks unfinished jobs interrupted;
it does not replay executable plans. Internal scans/plans are released after each
background job. Failed items do not block unrelated projects.

`jobs` returns all unfinished jobs for the authenticated owner/runtime, oldest
first, using summary counts (including failures) without transcript/receipt bodies.
New source jobs durably retain only their source IDs and fallback destination in a
private SQLite `request` column; responses expose only `resumable`. `resume` needs
`{ id, confirm: true }`, reuses the same job ID, and merges duplicate active retries.
Another active import rejects with `import_busy`. A transaction resets only that
job's attempt receipts/progress, never imported sessions, project registrations or
source files. Discovery/validation is repeated; deterministic revision IDs and
authoritative provenance readback skip committed sessions. Index callbacks and
project registration are retried independently. Settings retain the keep-existing
conflict policy. This is an idempotent retry, not a byte/file-offset resume.
Continue always uses the stored original source intent; the resume payload cannot
replace it with new sources or destinations. Legacy/explicit-plan jobs without
stored intent return `resume_request_missing` without resetting receipts or
starting a new import. The popup reports this limitation, never asks for a new
selection or silently selects all sources. Missing historical selections, merge
decisions and replace decisions cannot be reconstructed from result receipts.
After a failed Continue attempt the popup changes that import row's action to
Remove. `dismiss({ id })` durably marks only the authenticated owner/runtime's
inactive job as dismissed, excluding it from `jobs` and latest `job` results.
Running jobs reject dismissal with `import_busy`. Receipts and imported
conversations/projects/files remain untouched; repeated dismissal is idempotent.
Explicit historical job reads retain the receipt, but dismissed jobs cannot resume.

Discovery accepts optional `limitPerSource` (integer 1–10). This is a fast,
non-exhaustive sample: traversal/reads stop when that source reaches the limit,
including across roots, and Cursor editor bounds its composer-header SQL query.
With `includeCounts: true`, metadata traversal continues, but remaining transcript
bodies are not parsed. Candidate files are counted once per physical path;
Cursor editor combines `COUNT(*)` with bounded sample reads in the same private
snapshot, or reads only the count when enough examples were found elsewhere.
Counts are `{ value, approximate }` per source: positive values are estimates,
since duplicates/empty/malformed histories were not validated. Metadata-read or
traversal failure returns `value: null`, not a misleading partial/zero success.
The enumeration remains bounded to 20,000 entries; original DBs stay untouched.
Sample order is not a claim of catalog-wide recency.
Scan responses expose `sampled`; plans reject sampled scans with `incomplete_scan`.
The tour asks for five examples and metadata counts per tool, then scans selected tools fully only
on “Next”, preserving full-history import rather than importing just examples.
Scan summaries include a whitespace-normalized excerpt of up to 180 characters
from assistant text (falling back to user text), never tool records or reasoning.
OpenCode inventory pages official `session.list` metadata (100 per page, at most
5,000 sessions, 10-second request budget). A complete inventory gives an exact
count; failed/incomplete inventory gives an unknown count, while readable samples
remain visible. Only sampled OpenCode sessions request message projection (one
10-message page per example); full registration jobs never read message bodies.
This source is the connected instance, not an alternate database or export file.
Combined native/external discoveries retain the existing 5,000-session bound;
overflow is reported per omitted source without discarding readable retained
sessions. As before, this is a bounded import, not an unbounded catalog migration.

`imported({ scanID, directory })` is a separate read-only badge query for sampled
scans only. The scan retains already-computed source revisions, never rereads
transcript bodies for badges. It uses the same deterministic IDs/provenance as
separate imports, canonical destinations and parent revisions, with at most four
concurrent `session.get` calls, 50 examples and a shared five-second timeout.
Exact existing targets report `imported`; authoritative 404 reports `available`;
query failure, conflicts or a parent outside the sample report `unknown`, never
an invented unimported state. Badges are conservative, not catalog-wide totals.
Checks retain owner/runtime fencing and do not trust persisted receipts alone.

## Supported sources and conversion

| Source | Reader behavior |
| --- | --- |
| Claude Code | projects JSONL, active UUID parent chain, compaction/snips, parallel assistant tool fragments and subagents |
| Codex | sessions and archived_sessions JSONL, paired event/response user tracks, rollbacks, tool call/output pairs |
| Cursor | agent-transcripts JSONL; editor state.vscdb composer/bubble KV; CLI chats store.db meta, ordered protobuf message references and archives |
| DeepSeek Harness | session JSONL or concatenated Zstandard frames, latest physical generation, versions 0–4, sequenced surface replacement and tool/result pairing |
| OpenCode | current instance official session inventory; “Next” registers original projects and refreshes existing session index entries without `session.import` |

Known defaults respect the source-specific HOME/config environment overrides.
Explicit roots must be absolute Host paths. Sources remain untouched; unreadable
files are reported independently, not interpreted as an authoritative empty scan.
Symlink entries are skipped, and project rule/destination symlinks fail closed.
JSONL is capped at 64 MiB decompressed, 8 MiB per line and 100,000 records;
traversal at 20,000 entries and 5,000 sessions. SQLite snapshots are capped at
1 GiB. Missing Zstandard support is an explicit per-source error, not a Host
startup failure. Discovery deduplicates source identity across scan entry paths
and active/archive copies, preferring the more recently modified file.

This is not lossless native-runtime migration: tools/results become inert text,
reasoning remains reasoning text, and only available user inline image bytes are
retained. Missing/local-file attachments, runtime state, provider replay data,
permissions and historical usage are not reconstructed. Imported metadata marks
usage unknown; schema-required counters are zero, not recovered usage evidence.

## Merge, revisions and retry

Destination paths must be absolute and resolve through canonical existing ancestors.
Preview/validation never creates a directory. Confirmed execution creates missing
project directories and checks their canonical identity again, then uses the shared
project registry before importing a session. Registration failure prevents session
and settings writes for that project. Created directories/projects are not removed
on later failure, to preserve concurrent user work. Multiple source paths
may map to one destination project. Separate imports preserve selected parent/
child relationships with parents imported first. An unselected parent produces
an explicit detached-child warning. Parent failure blocks that subtree only.
Child target IDs incorporate the selected parent's revision ID.
Impossible self-parent metadata is normalized to a detached root with a
`parent_detached` warning; transcript contents are retained. Other parent cycles
fail their own entries with `invalid_parent_graph`, and descendants report
`parent_failed`; independent conversations continue. Parent ordering is iterative
and linear rather than recursive. Explicit merges flatten selected source
histories and do not depend on their original parent graph.
OpenCode entries retain their original IDs and locations. They cannot be merged
or redirected to another project; missing/deleted locations or sessions fail
independently. Registration/index failures remain retryable without copies.
Their existing project configuration is already native and is not rewritten.

Conversation merge is explicit, requires one destination and follows the scan
list/selection order. It creates a new session, removes only an exactly matching
shared prefix, inserts source boundary markers, and preserves repeated genuine
messages. It never appends to or overwrites existing OpenCode conversations.

Target IDs encode source installation/session identities, normalized revision,
destination, mode and parent revision. Exact repeat imports verify authoritative
metadata and skip; changed source content creates a new revision. Lost write
responses recover only through an exact authoritative read, never merely a 409.
Every successful import is read back through `session.get` and checked against
the expected ID, provenance and destination; a write acknowledgment alone is not
success. The session index receives that verified record. Index failure is
reported separately and retryable without duplicating the conversation.
Full receipts are durable; polled status returns
at most 80 recent/failed results plus the total completed count.

## Project settings

Selected histories identify source project roots. Root CLAUDE.md/AGENTS.md,
source rule folders, .cursorrules, and Markdown skill definitions are eligible.
Native in-place root instructions are skipped. Other unconditional rules go to
`.opencode/imported-rules/` and are added to effective instructions through the
existing JSONC config owner, preserving inherited instructions and comments.
Rules with `globs`, `paths` or `alwaysApply` metadata remain archived, not globally
enabled. Skills copy **SKILL.md only** to namespaced directories under
`.opencode/skills/`; supporting scripts and resources are not copied, so such
skills may need manual repair. This limit is disclosed before confirmation.
Global credentials, provider/auth settings, hooks, permissions, MCP and plugins
are excluded.
For source-based background jobs, settings planning failures (including symlinked
rule/skill roots) are recorded once per source project/destination as failed
settings items, without excluding readable conversations from that project. No
unsafe settings are read through symlinks or written. Explicit settings previews
still reject unsafe paths so callers can resolve them before confirming.

Conflicts default to keep existing; explicit keep-both uses a separate path;
replace backs up existing content first. Preview binds source/target/config
fingerprints. Changed data fails instead of silently overwriting. Failed config
activation compensates only the unchanged rule file written by this operation;
concurrent user edits are retained. Plans permit at most 200 rule/skill files,
512 KiB each and 4 MiB total. Partial failures leave unrelated successes valid;
re-preview and retry, rather than restarting a persisted executable plan.

## Verification

Focused Vitest tests cover format normalization, official transfer schema,
SQLite source immutability, repeat/lost-response imports, source changes,
ownership, runtime fencing, parent failures, merge, cancellation, receipts,
JSONC merging, conflict policies and unsafe paths. Real OpenCode smoke validation
must use synthetic sources and isolated HOME/XDG roots, never user histories.
