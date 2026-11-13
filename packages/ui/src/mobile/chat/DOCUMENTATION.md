# Mobile chat

## Remote project scope

Phone/iPad reuses the existing project list, conversation, Files and Changes
surfaces for the selected Host. Remote Projects does not add a mobile Terminal
entry or a separate Provider/plugin/MCP inventory panel. Machine configuration
remains in the existing instance/settings flow; the local MCP menu is unchanged.

`MobileChatHeader` resolves remote titles and machine identity from the explicit
Host boundary and remote navigation bridge, never a same-ID local session.
The title observes the existing Host/Location/generation-scoped session metadata
Query first, using summaries only for continuity. This disabled, memoized observer
does not fetch metadata or acquire content demand, including deep links before
the selected session appears in summaries.
Machine identity occupies the existing subtitle slot, not the session title.
The transcript sync whisper takes precedence; when it clears, the remote machine
indicator returns in that same slot. Local conversations have no machine subtitle.
Remote connection/preparation status has higher priority than transcript sync,
including warm cached transcripts and new drafts. Live checking/installing/
updating/starting phases use that same subtitle slot; offline/authorization/
incompatibility replaces loading instead of spinning indefinitely. Once connected,
the existing message-materialization/refresh hint and its hysteresis resume. Older
Hosts without phase projection retain a generic connection hint.
`MobileContextProgressButton` mounts separate local and remote consumers. The
remote leaf observes the already-bound Location transcript repository and scoped
model selection; it creates no content request or second lease. Closed metadata
does not request provider catalogs, Git or quotas. Its memo boundary keeps 50
unrelated parent renders from repeating transcript/model work.

`MobileChatScreen` also separates local and remote leaves. Only the local leaf
mounts Hub entity/load/materialization/config readers. The remote sync whisper
uses the scoped repository hydration/request projection, Host status and Location-
keyed refresh flights, retaining the same display hysteresis without a new content
lease. Its external-store snapshot is a phase string, so token updates that do not
change hydration do not rerender the phone shell. New remote draft model reads use
the shared `REMOTE_NEW_SESSION_DRAFT_ID`, never an empty raw ID.

`MobileParentSessionTarget.onSelect` lets the phone shell invoke authoritative
Host parent navigation before local chat-pop/close handling. Such targets never
enter the local predecessor/mirror store. Existing editor and `/btw` back handlers
retain priority.

Opening metadata reads Git (using the raw directory), quota display settings,
provider quotas and Magpie sources through captured Host entries. Query keys
include Hub/Host/Location and logical scope revision (`scopeGeneration`), independent
of physical wire reconnects. Refetch failure preserves
the last successful branch/usage snapshot and exposes error/retry. No remote read
uses Hub quota preferences; enabled remote auto-refresh runs only while metadata
is open, using the Host's bounded refresh interval. No remote read
loads local quota settings, starts the local quota timer, or consults local
directory/session/model/Git state. Changing Host or session remounts the panel
without carrying another machine's open state.

The existing branch, context, provider/account/model usage presentation remains
shared with local chat. These component tests do not establish iOS production
timing or real SSH/Relay reachability.
