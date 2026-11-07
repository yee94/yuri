/**
 * Official OpenCode v2 session_message projection page.
 *
 * SDK gap: `@opencode-ai/sdk@1.18.4` is not the v2 authority, and
 * `@opencode/client` is not approved for this cut. GET goes through the
 * existing Host shallow proxy + `runtimeFetch`. Host must not interpret body.
 *
 * First paint: limit=20, order=desc. Older history uses the response cursor.
 */
import type { Message, Part } from '@/lib/opencode/v2-types'
import { runtimeFetch } from '../lib/runtime-fetch'
import type { TranscriptTransportPage } from './transcript-repository'
import { mergeTranscriptOrder } from './transcript-order'
import { isProjectionObject as record, projectionString as asString, normalizeSessionProjectionMessage, isAuthoredUserTurnRecord } from './context-usage-projection'
export { normalizeSessionProjectionMessage, isAuthoredUserTurnRecord, isNativeSyntheticMessage, messageIDFromEventID, normalizeProjectionToolName } from './context-usage-projection'
export { SESSION_COMPACTION_STATUSES, isSessionCompactionCard, getSessionCompactionCard, type SessionCompactionStatus, type SessionCompactionReason, type SessionCompactionPart } from './session-compaction'

/** Official GUI first-paint page size. */
export const SESSION_PROJECTION_PAGE_LIMIT = 20

/** Official GUI first-paint / history order. */
export const SESSION_PROJECTION_PAGE_ORDER = 'desc'

export type FetchSessionProjectionPageInput = {
  sessionID: string
  directory: string
  cursor?: string
  signal?: AbortSignal
  limit?: number
  order?: 'asc' | 'desc'
}

const isJsonContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes('application/json')
}
const isHtmlContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes('text/html')
}

/**
 * Normalize a projection payload into transport records + cursor/complete.
 * `order=desc` pages are reversed so the existing window stays oldest→newest.
 */
export function normalizeSessionProjectionPage(
  payload: unknown,
  sessionID: string,
  order: 'asc' | 'desc' = SESSION_PROJECTION_PAGE_ORDER,
  limit: number = SESSION_PROJECTION_PAGE_LIMIT,
): TranscriptTransportPage {
  if (!record(payload)) throw new Error('session projection: expected JSON object')
  if (!Array.isArray(payload.data)) throw new Error('session projection: data must be an array')
  const records: TranscriptTransportPage['records'][number][] = []
  for (const item of payload.data) {
    const normalized = normalizeSessionProjectionMessage(sessionID, item)
    if (!normalized) continue
    records.push(normalized)
  }
  if (order === 'desc') records.reverse()
  // OpenCode 2.x message.list cursor contract (client 2.0.12):
  // - order=desc first/older pages advance via `cursor.next`
  // - order=asc advances via `cursor.previous`
  // A bare string cursor is treated as the continuation token for either order.
  const cursorObject = record(payload.cursor) ? payload.cursor : undefined
  const continuation = cursorObject ? asString(order === 'asc' ? cursorObject.previous : cursorObject.next) : asString(payload.cursor)
  // Native cursors are positions, not evidence another row exists. Count the
  // raw wire rows before filtering system/control messages: a short page is
  // exhausted, whereas a full system-only page must retain its continuation.
  const complete = !continuation || payload.data.length < limit
  const turnCount = records.filter(entry => isAuthoredUserTurnRecord(entry.info, entry.parts)).length
  return { records, cursor: complete ? undefined : continuation, complete, turnCount }
}

/**
 * GET `/api/session/:sessionID/message`
 * query: directory, limit, and either first-page order or an upstream cursor.
 */
export async function fetchSessionProjectionPage(input: FetchSessionProjectionPageInput): Promise<TranscriptTransportPage> {
  const limit = input.limit ?? SESSION_PROJECTION_PAGE_LIMIT
  const order = input.order ?? SESSION_PROJECTION_PAGE_ORDER
  const path = `/api/session/${encodeURIComponent(input.sessionID)}/message`
  const query: Record<string, string> = { directory: input.directory, limit: String(limit) }
  if (input.cursor) {
    // Durable boundaries are message anchors; native tokens remain opaque.
    // In descending order, `next` excludes the anchor and reads older rows.
    query.cursor = /^msg_[A-Za-z0-9_]+$/.test(input.cursor)
      ? btoa(JSON.stringify({ id: input.cursor, order, direction: order === 'desc' ? 'next' : 'previous' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      : input.cursor
  } else query.order = order
  const response = await runtimeFetch(path, { method: 'GET', query, signal: input.signal })
  if (!response.ok) throw new Error(`session projection failed (${response.status})`)
  const contentType = response.headers.get('content-type')
  if (isHtmlContentType(contentType)) throw new Error('session projection: unexpected HTML response')
  if (!isJsonContentType(contentType)) {
    // Still attempt JSON parse; many runtimes omit content-type. Reject HTML above.
  }
  let payload: unknown
  try { payload = await response.json() }
  catch { throw new Error('session projection: malformed JSON') }
  return normalizeSessionProjectionPage(payload, input.sessionID, order, limit)
}

export type ReconcileFetchedRecord = { info: Message; parts: Part[] }
export type ReconcileFetchedInput = {
  /** This GET page, already oldest → newest. */
  fetched: readonly ReconcileFetchedRecord[]
  /** Visible transcript before the GET settled. */
  previous: readonly ReconcileFetchedRecord[]
  /** Message ids SSE changed while this GET was in flight. */
  touched?: ReadonlySet<string>
  /** Only projection rows establish the covered range; context/parent additions do not. */
  coverageMessageIDs?: readonly string[]
  /**
   * True when the GET positively covers the entire session.
   * Complete tails take the GET id set as authority; incomplete pages keep
   * earlier local rows the GET did not return.
   */
  completeTail: boolean
}

/**
 * Official GUI reconcileFetched: fetched is the base, touched ids keep the
 * local row, and an incomplete page keeps earlier unfetched rows.
 */
export function reconcileFetched(input: ReconcileFetchedInput): ReconcileFetchedRecord[] {
  const fetched = input.fetched.filter(record => Boolean(record.info?.id))
  const previous = input.previous.filter(record => Boolean(record.info?.id))
  const touched = input.touched ?? new Set<string>()
  const result = new Map(fetched.map(record => [record.info.id, record]))
  const live = new Map(previous.map(record => [record.info.id, record]))
  const coveredIDs = new Set(input.coverageMessageIDs ?? fetched.map(record => record.info.id))
  const firstFetchedIndex = previous.findIndex(record => coveredIDs.has(record.info.id))
  if (!input.completeTail) for (const [index, record] of previous.entries()) {
    if (result.has(record.info.id)) continue
    const earlier = firstFetchedIndex === -1 || index < firstFetchedIndex
    if (earlier) result.set(record.info.id, record)
  }
  for (const id of touched) {
    const item = live.get(id)
    if (item) result.set(id, item)
    else result.delete(id)
  }
  const previousIDs = previous.map(record => record.info.id).filter(id => result.has(id))
  const fetchedIDs = fetched.map(record => record.info.id).filter(id => result.has(id))
  // A disjoint incomplete tail retains the older local window before it.
  const hasOverlap = fetchedIDs.some(id => live.has(id))
  const order = !input.completeTail && !hasOverlap ? [...new Set([...previousIDs, ...fetchedIDs])] : mergeTranscriptOrder(previousIDs, fetchedIDs)
  return order.map(id => result.get(id)!)
}
