import { parseAssistantReadPosition, parseAssistantReadResponse, type AssistantReadPosition } from '../ui/src/queries/assistantDTO';
import type { PageOperation } from './page-operations';

export type DesktopAssistantReadMarkerOperation = Pick<PageOperation, 'current' | 'request'>;
export type DesktopAssistantReadMarkerRect = { x: number; y: number; width: number; height: number };
export type DesktopAssistantReadMarkerMeasurement = { marker: DesktopAssistantReadMarkerRect; viewport: DesktopAssistantReadMarkerRect };
export type DesktopAssistantReadMarkerFrame = {
  offset: { x: number; y: number };
  contentSize: { width: number; height: number };
  size: { width: number; height: number };
};
export type DesktopAssistantReadMarkerOptions = {
  assistantID: string;
  /** Actual active, foreground, interactive contact owner, including Host identity. */
  current: () => boolean;
  /** Only the authoritative latest real position in a gap-free contact projection. */
  position: () => AssistantReadPosition | null;
  operation: () => DesktopAssistantReadMarkerOperation | null;
  /** Both native rectangles must use the same coordinate system. */
  measure: () => Promise<DesktopAssistantReadMarkerMeasurement | null>;
  now?: () => number;
};

type Target = { operation: DesktopAssistantReadMarkerOperation; position: AssistantReadPosition };
function samePosition(left: AssistantReadPosition, right: AssistantReadPosition) {
  return left.generation === right.generation && left.ordinal === right.ordinal && left.messageID === right.messageID;
}
function sameTarget(left: Target | null, right: Target) {
  return left?.operation === right.operation && samePosition(left.position, right.position);
}
function validRect(rect: DesktopAssistantReadMarkerRect) {
  return [rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0;
}
function visible(value: DesktopAssistantReadMarkerMeasurement | null) {
  if (!value || !validRect(value.marker) || !validRect(value.viewport)) return false;
  const { marker, viewport } = value;
  return marker.y >= viewport.y && marker.y + marker.height <= viewport.y + viewport.height
    && marker.x >= viewport.x && marker.x + marker.width <= viewport.x + viewport.width;
}
function latest(frame: DesktopAssistantReadMarkerFrame) {
  const { offset, contentSize, size } = frame;
  if (![offset.x, offset.y, contentSize.width, contentSize.height, size.width, size.height].every(Number.isFinite)
    || contentSize.width <= 0 || contentSize.height <= 0 || size.width <= 0 || size.height <= 0) return false;
  const bottom = contentSize.height - size.height - offset.y;
  return Number.isFinite(bottom) && Math.abs(bottom) <= 2;
}

/** Pure event-driven adapter. The existing List and PageOperation retain all native ownership. */
export function createDesktopAssistantReadMarker(options: DesktopAssistantReadMarkerOptions) {
  const now = options.now ?? Date.now;
  const path = `/api/yuri/assistants/${encodeURIComponent(options.assistantID)}/contact/read`;
  let alive = true, revision = 0;
  let frame: DesktopAssistantReadMarkerFrame | null = null;
  let flight: Promise<boolean> | null = null;
  let done: Target | null = null;
  let failure: { target: Target; retryAt: number } | null = null;

  function target(): Target | null {
    if (!alive || !options.current()) return null;
    const operation = options.operation();
    if (!operation || !operation.current()) return null;
    const position = options.position();
    if (!position) return null;
    try { return { operation, position: parseAssistantReadPosition(position) }; }
    catch { return null; }
  }
  function eligible(): Target | null {
    const captured = target();
    if (!captured || !frame || !latest(frame) || sameTarget(done, captured)) return null;
    if (failure && !sameTarget(failure.target, captured)) failure = null;
    if (failure && (!Number.isFinite(now()) || now() < failure.retryAt)) return null;
    return captured;
  }
  function stillCurrent(captured: Target) { return sameTarget(target(), captured); }
  function failed(captured: Target) {
    if (stillCurrent(captured)) failure = { target: captured, retryAt: now() + 15_000 };
  }

  async function run() {
    let accepted = false;
    try {
      while (alive) {
        const serial = revision, captured = eligible(), capturedFrame = frame;
        if (!captured) return accepted;
        let measurement: DesktopAssistantReadMarkerMeasurement | null;
        try { measurement = await options.measure(); }
        catch {
          if (serial !== revision) continue;
          failed(captured);
          return accepted;
        }
        // A new layout/check/scroll revokes the old measurement, even at the same offset.
        if (serial !== revision) continue;
        if (frame !== capturedFrame || !stillCurrent(captured) || !visible(measurement)) return accepted;
        try {
          const result = parseAssistantReadResponse(await captured.operation.request(path, 'POST', captured.position));
          if (result.assistantID !== options.assistantID) throw new Error('invalid_assistant_read_response');
          if (stillCurrent(captured)) {
            done = captured;
            failure = null;
            accepted = true;
          }
        } catch { failed(captured); }
        // Only an explicit event during the await can request another pass. No timer/replay.
        if (serial === revision) return accepted;
      }
      return accepted;
    } finally {
      // Release synchronously with the last eligibility decision, not in a later
      // promise reaction that could swallow a new explicit check in between.
      flight = null;
    }
  }

  function check(): Promise<boolean> {
    revision++;
    if (flight) return flight;
    if (!eligible()) return Promise.resolve(false);
    const pending = Promise.resolve().then(run);
    flight = pending;
    return pending;
  }
  function retire() { alive = false; revision++; frame = null; done = null; failure = null; }
  return {
    invalidateFrame() { revision++; frame = null; },
    scroll(value: DesktopAssistantReadMarkerFrame) {
      if (!alive) return;
      frame = {
        offset: { ...value.offset }, contentSize: { ...value.contentSize }, size: { ...value.size },
      };
      void check();
    },
    check,
    retire,
    dispose: retire,
  };
}
