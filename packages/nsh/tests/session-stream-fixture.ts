/** Capture the actual issued native start, including its exact lease and owner.
 * Callers may retain this value to exercise a stale owner; never re-sign it
 * from mutable application state when delivering a delayed frame.
 */
const starts = new WeakMap<object, Map<string, Record<string, unknown>>>();
export function captureIssuedStream(call: object, input: Record<string, unknown>) {
  const entries = starts.get(call) ?? new Map();
  entries.set(String(input.key), structuredClone(input)); starts.set(call, entries);
}
export function resetIssuedStreams(call: object) { starts.delete(call); }
export function issuedStream(call: object, key = 'chat') {
  const input = starts.get(call)?.get(key);
  // Root/global fixtures predate the session-only ticket contract. A missing
  // global start remains unbound; never manufacture a current lease for it.
  if (!input && key === 'global') return { key };
  if (!input) throw new Error(`Fixture has no issued ${key} stream`);
  return { key, expectedHost: structuredClone(input.expectedHost), ...(key === 'chat' ? { ownerID: input.ownerID } : {}) };
}
