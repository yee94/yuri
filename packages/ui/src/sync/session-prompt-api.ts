/**
 * Official OpenCode v2 prompt admission + inbox + interrupt.
 *
 * Verified against `@opencode/client` / protocol **2.0.12** (upstream core
 * inbox `admit` + `reconcile` by stable message id; promoted-from-message is
 * treated as already admitted). Yuri POSTs through the Host shallow
 * proxy + `runtimeFetch` so the Host never interprets the body.
 *
 * Idle send: POST `/api/session/:sessionID/prompt` with `delivery: "steer"`.
 * Busy send: same path with `delivery: "queue"`. Success is an **inbox** item
 * (pending near the composer), not a transcript row — consumption moves the
 * same id into message projection.
 * Inbox (SDK 2.0.12 / verified through 2.0.15; prompt routes unchanged):
 * - GET `/api/session/:sessionID/inbox`
 * - PATCH `/api/session/:sessionID/inbox/:inboxID` body `{ delivery }` → 204
 * - DELETE `/api/session/:sessionID/inbox/:inboxID` → 204
 * Interrupt: POST `/api/session/:sessionID/interrupt`.
 *
 * Known SSE (handle via `applySessionInboxEvent`, not transcript merge):
 * - `session.inbox.enqueued` → remember pending (**user** items only)
 * - `session.inbox.cancelled` → forget pending
 * - `session.inbox.delivery.changed` → update delivery
 * - `session.inbox.delivered` → forget pending (history owns the id)
 * Unknown event types: leave overlay state untouched.
 */

import { runtimeFetch } from "../lib/runtime-fetch"
import type { HostRuntimeEntry } from "@/lib/remote-projects/registry"
import { locationSessionKey, type HostLocation } from "@/lib/remote-projects/location"
import { getRuntimeGeneration, getRuntimeKey } from "../lib/runtime-switch"
import {
  captureInboxAuthorityMark,
  captureInboxRuntimeScope,
  forgetUnpromotedInbox,
  getInboxTerminal,
  isCurrentInboxRuntimeScope,
  rememberUnpromotedInbox,
  rememberUnpromotedInboxFromAuthority,
  replaceInboxOverlayFromAuthority as replaceOverlayFromAuthority,
  type InboxAuthorityOptions,
  type InboxRuntimeScope,
  updateInboxOverlayDelivery,
  useSessionInboxOverlayStore,
} from "./session-inbox-overlay"
import {
  captureCompactionBarrierRevision,
  parseSessionInboxCompactionList,
  setSessionCompactionBarrier,
  syncCompactionBarrierFromInbox,
} from "./session-compaction-api"
import { fetchSessionProjectionPage } from "./session-projection-api"

export type SessionInboxDelivery = "steer" | "queue"

export type SessionInboxUser = {
  location?: HostLocation
  id: string
  sessionID: string
  timeCreated: number
  type: "user"
  delivery: SessionInboxDelivery
  payload: {
    text: string
    files?: unknown
    agents?: unknown
    skills?: unknown
    metadata?: Record<string, unknown>
  }
}

export type PostIdleSessionPromptInput = {
  scope?: HostRuntimeEntry
  sessionID: string
  directory: string
  messageID: string
  text: string
  files?: Array<{ uri: string; name?: string }>
  agents?: Array<{ name: string }>
  skills?: Array<{ id: string }>
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}

export type PostSessionPromptInput = PostIdleSessionPromptInput & {
  delivery?: SessionInboxDelivery
}

export type PostSessionInterruptInput = {
  scope?: HostRuntimeEntry
  sessionID: string
  directory?: string | null
  resume?: boolean
  signal?: AbortSignal
}

export type SessionInboxMutationInput = {
  scope?: HostRuntimeEntry
  sessionID: string
  inboxID: string
  directory?: string | null
  signal?: AbortSignal
}

export type FetchSessionInboxInput = {
  scope?: HostRuntimeEntry
  sessionID: string
  directory?: string | null
  signal?: AbortSignal
}

/** GET inbox snapshot with request-start mark for terminal ordering. */
export type SessionInboxAuthoritySnapshot = {
  items: SessionInboxUser[]
  /** High-water mark at request start; terminals with mark > this beat the snapshot. */
  startedMark: number
  scope: InboxRuntimeScope
  /** False when runtime switched before response side effects may run. */
  current: boolean
}

const isJsonContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("application/json")
}

const isHtmlContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("text/html")
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function throwHttp(label: string, status: number, detail?: string): never {
  const suffix = detail ? `: ${detail}` : ""
  const error = new Error(`${label} (${status})${suffix}`) as Error & { status?: number }
  error.status = status
  throw error
}

async function readFailedDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim()
    if (!text) return ""
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      if (typeof body.error === "string" && body.error.trim()) {
        return body.error.trim()
      }
      if (typeof body.message === "string" && body.message.trim()) {
        return body.message.trim()
      }
    } catch {
      // Plain-text upstream body
    }
    return text
  } catch {
    return ""
  }
}

function directoryQuery(directory?: string | null): Record<string, string> {
  return directory ? { directory } : {}
}

function inboxPath(sessionID: string, inboxID?: string): string {
  const session = `/api/session/${encodeURIComponent(sessionID)}/inbox`
  if (!inboxID) return session
  return `${session}/${encodeURIComponent(inboxID)}`
}

function scopedInboxSessionID(sessionID: string, scope?: HostRuntimeEntry): string {
  return scope ? locationSessionKey(scope.location, sessionID) : sessionID
}

async function parseJsonBody(response: Response, label: string): Promise<unknown> {
  const contentType = response.headers.get("content-type")
  if (isHtmlContentType(contentType)) {
    throw new Error(`${label}: unexpected HTML response`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`${label}: malformed JSON`)
  }
  if (!isJsonContentType(contentType) && payload == null) {
    throw new Error(`${label}: empty response`)
  }
  return payload
}

/**
 * Accept only `type: "user"` (or legacy omitted type). Synthetic / compaction /
 * move must not become composer chips.
 */
export function parseSessionInboxUser(payload: unknown): SessionInboxUser {
  const root = record(payload) ? payload : null
  const item = root && record(root.data) ? root.data : root
  if (!item) {
    throw new Error("session prompt: expected inbox item")
  }
  const itemType = asString(item.type)
  if (itemType && itemType !== "user") {
    throw new Error(`session prompt: expected user inbox item, got ${itemType}`)
  }
  const id = asString(item.id)
  const sessionID = asString(item.sessionID)
  if (!id || !sessionID) {
    throw new Error("session prompt: inbox item missing id")
  }
  const payloadRecord = record(item.payload) ? item.payload : {}
  const delivery = item.delivery === "queue" ? "queue" : "steer"
  const timeRec = record(item.time) ? item.time : null
  return {
    id,
    sessionID,
    timeCreated: asNumber(item.timeCreated) ?? asNumber(timeRec?.created) ?? Date.now(),
    type: "user",
    delivery,
    payload: {
      text: asString(payloadRecord.text) ?? asString(item.text) ?? "",
      ...(payloadRecord.files !== undefined ? { files: payloadRecord.files } : {}),
      ...(payloadRecord.agents !== undefined ? { agents: payloadRecord.agents } : {}),
      ...(payloadRecord.skills !== undefined ? { skills: payloadRecord.skills } : {}),
      ...(record(payloadRecord.metadata) ? { metadata: payloadRecord.metadata } : {}),
    },
  }
}

export function parseSessionInboxList(payload: unknown): SessionInboxUser[] {
  const root = record(payload) ? payload : null
  const list = root && Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : null
  if (!list) {
    throw new Error("session inbox: expected list")
  }
  const items: SessionInboxUser[] = []
  for (const entry of list) {
    if (!record(entry)) continue
    if (entry.type && entry.type !== "user") continue
    items.push(parseSessionInboxUser(entry))
  }
  return items
}

/**
 * Unpromoted inbox items are not transcript rows. Callers show them near the
 * composer; promote + projection owns the user line.
 */
export function transcriptRowsFromIdlePromptResponse(_payload: unknown): [] {
  return []
}

export type PromptCommitScope = {
  hostScope?: HostRuntimeEntry
  /** Prefer runtime key (client) or transport identity — compared with capture. */
  runtimeKey: string
  generation: number
  directory: string
  overlay: InboxRuntimeScope
}

export function capturePromptCommitScope(directory: string, hostScope?: HostRuntimeEntry): PromptCommitScope {
  return {
    runtimeKey: getRuntimeKey(),
    generation: getRuntimeGeneration(),
    directory: hostScope?.location.directory ?? directory,
    hostScope,
    overlay: captureInboxRuntimeScope(),
  }
}

export function isCurrentPromptCommitScope(scope: PromptCommitScope): boolean {
  try {
    scope.hostScope?.sdk()
  } catch {
    return false
  }
  return (
    getRuntimeKey() === scope.runtimeKey
    && getRuntimeGeneration() === scope.generation
    && isCurrentInboxRuntimeScope(scope.overlay)
  )
}

function throwRuntimeSwitched(label: string): never {
  const error = new Error(`${label}: runtime switched`)
  error.name = "RuntimeGenerationMismatchError"
  throw error
}

export async function postSessionPrompt(
  input: PostSessionPromptInput & { commit?: PromptCommitScope },
): Promise<SessionInboxUser> {
  // Earliest entry: pin commit boundary before any network side effect.
  const commit = input.commit ?? capturePromptCommitScope(input.directory, input.scope)
  if (input.scope && commit.hostScope !== input.scope) throw new Error("Prompt scope mismatch")
  if (!isCurrentPromptCommitScope(commit)) {
    throwRuntimeSwitched("session prompt")
  }

  const path = `/api/session/${encodeURIComponent(input.sessionID)}/prompt`
  const body: Record<string, unknown> = {
    id: input.messageID,
    text: input.text,
    delivery: input.delivery === "queue" ? "queue" : "steer",
  }
  if (input.files?.length) body.files = input.files
  if (input.agents?.length) body.agents = input.agents
  if (input.skills?.length) body.skills = input.skills
  body.metadata = {
    ...input.metadata,
    client: {
      ...(record(input.metadata?.client) ? input.metadata.client : {}),
      id: "yuri",
    },
  }

  const response = await (commit.hostScope ? commit.hostScope.fetch : runtimeFetch)(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    query: { directory: commit.directory },
    body: JSON.stringify(body),
    signal: input.signal,
  })

  if (!isCurrentPromptCommitScope(commit)) {
    throwRuntimeSwitched("session prompt")
  }

  if (!response.ok) {
    const detail = await readFailedDetail(response)
    throwHttp("Failed to send message", response.status, detail)
  }

  const admitted = parseSessionInboxUser(await parseJsonBody(response, "session prompt"))
  if (commit.hostScope && admitted.sessionID !== input.sessionID) throw new Error("Session prompt response scope mismatch")
  if (commit.hostScope) admitted.location = commit.hostScope.location
  // Commit overlay only on the captured boundary. Terminal cancelled/consumed
  // receipts make remember a no-op so late HTTP cannot resurrect ghosts.
  if (!isCurrentPromptCommitScope(commit)) {
    throwRuntimeSwitched("session prompt")
  }
  rememberUnpromotedInbox(admitted)
  return admitted
}

/**
 * Explicit reject (permission / validation / conflict) must not be retried.
 * Transport timeouts (408), rate limits (429), and non-HTTP failures stay
 * ambiguous so fixed-id reconcile + one prompt-only retry can run.
 */
export function isPromptAdmissionRejected(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status !== "number" || !Number.isFinite(status)) return false
  if (status === 408 || status === 429) return false
  return status >= 400 && status < 500
}

export type PromptAdmissionReconcileResult =
  | { status: "pending"; item: SessionInboxUser }
  | { status: "promoted"; id: string }
  | { status: "unknown" }

/**
 * Fixed-input-id reconcile after a lost/ambiguous prompt response.
 * Covers inbox-pending and already-projected (consumed) states without minting
 * a new logical submission.
 */
export async function reconcilePromptAdmission(input: {
  scope?: HostRuntimeEntry
  sessionID: string
  directory?: string | null
  inputID: string
  signal?: AbortSignal
  commit?: PromptCommitScope
}): Promise<PromptAdmissionReconcileResult> {
  const inputID = input.inputID.trim()
  if (!inputID) return { status: "unknown" }

  const commit = input.commit ?? capturePromptCommitScope(input.directory ?? "", input.scope)
  if (!isCurrentPromptCommitScope(commit)) return { status: "unknown" }

  try {
    const snap = await fetchSessionInboxAuthority({
      scope: commit.hostScope,
      sessionID: input.sessionID,
      directory: commit.directory || input.directory,
      signal: input.signal,
    })
    if (!isCurrentPromptCommitScope(commit) || !snap.current) return { status: "unknown" }
    const pending = snap.items.find((item) => item.id === inputID)
    if (pending) {
      // Authority pending clears terminal only when the GET is not older than it.
      const admitted = rememberUnpromotedInboxFromAuthority(pending, {
        startedMark: snap.startedMark,
      })
      if (!admitted) return { status: "unknown" }
      return { status: "pending", item: pending }
    }
  } catch {
    // Inbox miss is not authoritative failure — try projection.
  }

  if (!isCurrentPromptCommitScope(commit)) return { status: "unknown" }

  try {
    const page = await fetchSessionProjectionPage({
      scope: commit.hostScope,
      sessionID: input.sessionID,
      directory: commit.directory || input.directory || "",
      limit: 40,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (!isCurrentPromptCommitScope(commit)) return { status: "unknown" }
    const promoted = page.records.some((record) => record?.info?.id === inputID)
    if (promoted) {
      forgetUnpromotedInbox(scopedInboxSessionID(input.sessionID, commit.hostScope), inputID, "consumed")
      return { status: "promoted", id: inputID }
    }
  } catch {
    // Projection miss keeps unknown so the caller may prompt-retry once.
  }

  // Empty inbox + empty projection: unknown (pending-not-visible vs cancelled).
  // Do not remember a draft-shaped row and do not clear terminal receipts.
  return { status: "unknown" }
}

/**
 * Narrow known-inbox-event adapter for the composer overlay. Unknown types
 * return false and leave state alone (diagnostics stay on the event pipeline).
 * Enqueued synthetic / compaction / move never become empty user chips.
 */
export function applySessionInboxEvent(event: {
  type?: string
  properties?: Record<string, unknown> | null
}, scope?: HostRuntimeEntry): boolean {
  const type = typeof event.type === "string" ? event.type : ""
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : null
  if (!props) return false
  const sessionID = asString(props.sessionID)
  const inboxID = asString(props.inboxID) ?? asString(props.id)
  if (!sessionID || !inboxID) return false
  const key = scopedInboxSessionID(sessionID, scope)

  if (type === "session.inbox.enqueued") {
    const itemPayload = props.item
    const itemType = record(itemPayload) ? asString(itemPayload.type) : undefined
    // Precise filter: only user (or legacy omitted type) enter the chip overlay.
    if (itemType && itemType !== "user") {
      return false
    }
    try {
      const admitted = parseSessionInboxUser(
        record(itemPayload)
          ? { ...itemPayload, id: inboxID, sessionID, type: itemType ?? "user" }
          : { id: inboxID, sessionID, type: "user", delivery: "steer", payload: { text: "" } },
      )
      if (scope) admitted.location = scope.location
      // Live SSE authority — no startedMark (may clear prior terminal).
      rememberUnpromotedInboxFromAuthority(admitted)
      return true
    } catch {
      // Malformed user payload: do not mint an empty ghost chip.
      return false
    }
  }

  if (type === "session.inbox.cancelled") {
    forgetUnpromotedInbox(key, inboxID, "cancelled")
    return true
  }

  if (type === "session.inbox.delivered") {
    forgetUnpromotedInbox(key, inboxID, "consumed")
    return true
  }

  if (type === "session.inbox.delivery.changed") {
    const delivery = props.delivery === "queue" ? "queue" : props.delivery === "steer" ? "steer" : null
    if (!delivery) return false
    updateInboxOverlayDelivery(key, inboxID, delivery)
    return true
  }

  return false
}

export async function postIdleSessionPrompt(
  input: PostIdleSessionPromptInput,
): Promise<SessionInboxUser> {
  return postSessionPrompt({ ...input, delivery: "steer" })
}

/**
 * GET inbox with runtime scope + request-start mark. Compaction barrier side
 * effects run only while the captured runtime scope is still current.
 */
export async function fetchSessionInboxAuthority(
  input: FetchSessionInboxInput,
): Promise<SessionInboxAuthoritySnapshot> {
  const scope = captureInboxRuntimeScope()
  const commit = capturePromptCommitScope(input.directory ?? "", input.scope)
  const startedMark = captureInboxAuthorityMark()
  const key = scopedInboxSessionID(input.sessionID, input.scope)
  const compactionRevision = captureCompactionBarrierRevision(key)
  const options = {
    method: "GET",
    query: directoryQuery(input.scope?.location.directory ?? input.directory),
    signal: input.signal,
  }
  const request = input.scope ? input.scope.fetch : runtimeFetch
  let response = await request(`/api/sessions/${encodeURIComponent(input.sessionID)}/delivery`, options)
  // Standalone VS Code and older Hosts do not own this projection route.
  if (response.status === 404 || response.status === 501 || isHtmlContentType(response.headers.get("content-type"))) {
    response = await request(inboxPath(input.sessionID), options)
  }
  if (!response.ok) {
    throwHttp("session inbox", response.status, await readFailedDetail(response))
  }
  const payload = await parseJsonBody(response, "session inbox")
  const items = parseSessionInboxList(payload)
  if (input.scope && items.some((item) => item.sessionID !== input.sessionID)) throw new Error("Session inbox response scope mismatch")
  if (input.scope) for (const item of items) item.location = input.scope.location
  const current = isCurrentInboxRuntimeScope(scope) && isCurrentPromptCommitScope(commit)
  if (current && captureCompactionBarrierRevision(key) === compactionRevision) {
    if (record(payload) && typeof payload.compactionRunning === "boolean") {
      setSessionCompactionBarrier(key, payload.compactionRunning)
    } else {
      syncCompactionBarrierFromInbox(key, parseSessionInboxCompactionList(payload))
    }
  }
  return { items, startedMark, scope, current }
}

export async function fetchSessionInbox(input: FetchSessionInboxInput): Promise<SessionInboxUser[]> {
  const snap = await fetchSessionInboxAuthority(input)
  return snap.items
}

/**
 * SDK `session.inbox.update`: PATCH body `{ delivery }` → 204 empty.
 * Updates overlay delivery only on the captured runtime scope when no terminal
 * owns the id. Returns void — callers apply known delivery locally if needed.
 */
async function patchSessionInboxDelivery(
  input: SessionInboxMutationInput & { delivery: SessionInboxDelivery },
): Promise<void> {
  const scope = captureInboxRuntimeScope()
  const commit = capturePromptCommitScope(input.directory ?? "", input.scope)
  const response = await (input.scope ? input.scope.fetch : runtimeFetch)(inboxPath(input.sessionID, input.inboxID), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    query: directoryQuery(input.scope?.location.directory ?? input.directory),
    body: JSON.stringify({ delivery: input.delivery }),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp(
      input.delivery === "steer" ? "session inbox steer" : "session inbox queue",
      response.status,
      await readFailedDetail(response),
    )
  }
  // 204 No Content — do not parse a body.
  if (!isCurrentInboxRuntimeScope(scope) || !isCurrentPromptCommitScope(commit)) {
    return
  }
  const key = scopedInboxSessionID(input.sessionID, input.scope)
  if (getInboxTerminal(key, input.inboxID)) {
    return
  }
  updateInboxOverlayDelivery(key, input.inboxID, input.delivery)
}

export async function steerSessionInbox(input: SessionInboxMutationInput): Promise<void> {
  await patchSessionInboxDelivery({ ...input, delivery: "steer" })
}

export async function queueSessionInbox(input: SessionInboxMutationInput): Promise<void> {
  await patchSessionInboxDelivery({ ...input, delivery: "queue" })
}

export async function cancelSessionInbox(input: SessionInboxMutationInput): Promise<void> {
  const response = await (input.scope ? input.scope.fetch : runtimeFetch)(inboxPath(input.sessionID, input.inboxID), {
    method: "DELETE",
    query: directoryQuery(input.scope?.location.directory ?? input.directory),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session inbox cancel", response.status, await readFailedDetail(response))
  }
}

export function replaceInboxOverlayFromAuthority(
  sessionID: string,
  items: readonly SessionInboxUser[],
  options?: InboxAuthorityOptions,
): void {
  replaceOverlayFromAuthority(sessionID, items, options)
}

export async function cancelUnpromotedInboxItem(input: SessionInboxMutationInput): Promise<{
  overlay: SessionInboxUser[]
  transcriptRows: []
}> {
  const overlayScope = captureInboxRuntimeScope()
  const commit = capturePromptCommitScope(input.directory ?? "", input.scope)
  const key = scopedInboxSessionID(input.sessionID, input.scope)
  await cancelSessionInbox(input)
  // Do not record terminal or mutate overlay after a runtime switch mid-flight.
  if (!isCurrentInboxRuntimeScope(overlayScope) || !isCurrentPromptCommitScope(commit)) {
    return {
      overlay: useSessionInboxOverlayStore.getState().list(key),
      transcriptRows: [],
    }
  }
  // Terminal cancelled first so a concurrent late POST cannot re-admit the chip.
  forgetUnpromotedInbox(key, input.inboxID, "cancelled")
  try {
    const snap = await fetchSessionInboxAuthority({
      scope: input.scope,
      sessionID: input.sessionID,
      directory: input.directory,
      signal: input.signal,
    })
    if (!isCurrentInboxRuntimeScope(overlayScope) || !isCurrentPromptCommitScope(commit) || !snap.current) {
      return {
        overlay: useSessionInboxOverlayStore.getState().list(key),
        transcriptRows: [],
      }
    }
    replaceInboxOverlayFromAuthority(key, snap.items, {
      startedMark: snap.startedMark,
    })
  } catch {
    // DELETE already won; a refresh miss must not resurrect the cancelled item.
  }
  return {
    overlay: useSessionInboxOverlayStore.getState().list(key),
    transcriptRows: [],
  }
}

export async function postSessionInterrupt(input: PostSessionInterruptInput): Promise<void> {
  const path = `/api/session/${encodeURIComponent(input.sessionID)}/interrupt`
  const query: Record<string, string> = {}
  const directory = input.scope?.location.directory ?? input.directory
  if (directory) query.directory = directory
  if (input.resume !== undefined) query.resume = String(input.resume)

  const response = await (input.scope ? input.scope.fetch : runtimeFetch)(path, {
    method: "POST",
    query,
    signal: input.signal,
  })

  if (!response.ok) {
    throw new Error(`Session interrupt failed (${response.status})`)
  }
}

export type ConfirmOptimisticAgainstPromotedInput = {
  optimisticID: string
  promotedIDs: readonly string[]
  removeOptimistic: (id: string) => void
  refreshFromAuthority: () => Promise<void>
}

/**
 * After promote, the projection user row must share the optimistic id.
 * A miss drops the optimistic shell and force-GETs the tail.
 */
export async function confirmOptimisticAgainstPromoted(
  input: ConfirmOptimisticAgainstPromotedInput,
): Promise<"confirmed" | "refreshed"> {
  if (input.promotedIDs.includes(input.optimisticID)) {
    return "confirmed"
  }
  input.removeOptimistic(input.optimisticID)
  await input.refreshFromAuthority()
  return "refreshed"
}
