import { normalizeSessionProjectionMessage } from '../ui/src/sync/context-usage-projection';
import { record, text, type Message } from './model';
import { contextUsageEntryStructureKey, type ContextUsageEntry, type ContextUsageScope, type ContextUsageSnapshot } from './context-usage-core';

const entries = new WeakMap<Message, { sessionID: string; entry: ContextUsageEntry | null }>();

function legacyEntry(info: Record<string, unknown>, parts: unknown, sessionID: string, messageID: string): ContextUsageEntry {
  const canonicalInfo: Record<string, unknown> = { ...info, sessionID: text(info.sessionID) || sessionID, time: info.time ?? {} };
  const value = { info: canonicalInfo, parts };
  function valid(entry: typeof value): entry is typeof value & ContextUsageEntry {
    return entry.info.id === messageID && entry.info.sessionID === sessionID && typeof entry.info.role === 'string'
      && !!entry.info.time && typeof entry.info.time === 'object' && !Array.isArray(entry.info.time)
      && Array.isArray(entry.parts) && entry.parts.every(part => typeof record(part).id === 'string' && typeof record(part).type === 'string' && (!record(part).sessionID || record(part).sessionID === sessionID) && (!record(part).messageID || record(part).messageID === messageID));
  }
  if (!valid(value)) throw new Error('Invalid legacy context overview source');
  return value;
}

/** Adapt retained wire data using the SAME normalizer as Web; never reconstruct usage from slim Message. */
export function contextUsageEntryFromNative(message: Message, sessionID: string): ContextUsageEntry | null {
  const cached = entries.get(message);
  if (cached) {
    if (cached.sessionID !== sessionID) throw new Error('Context overview message reused across sessions');
    return cached.entry;
  }
  const raw = message.contextRaw;
  if (!raw) throw new Error('Context overview needs the original received projection; refresh the existing Chat authority');
  const legacy = record(raw.info);
  if (text(raw.id ?? legacy.id) !== message.id || (raw.type !== 'synthetic' && text(raw.sessionID ?? legacy.sessionID) && (raw.sessionID ?? legacy.sessionID) !== sessionID)) throw new Error('Context overview source identity mismatch');
  let normalized: ContextUsageEntry | null;
  const overlaid = message.contextLive || !!message.contextContent && message.content !== message.contextContent;
  const currentParts = (original: unknown) => overlaid && message.content ? message.content.map((part, index) => ({ ...part, id: text(part.id) || `${message.id}:${text(part.type)}:${index}`, messageID: message.id, sessionID })) : original;
  if (text(legacy.id) && Array.isArray(raw.parts)) {
    normalized = legacyEntry(legacy, currentParts(raw.parts), sessionID, message.id);
  } else if (!raw.type && text(raw.role) && Array.isArray(raw.parts)) {
    const { parts, ...info } = raw;
    normalized = legacyEntry(info, currentParts(parts), sessionID, message.id);
  } else {
    const native = message.contextOrigin === 'stream' || raw.type === 'assistant' ? { ...raw, ...(message.content ? { content: message.content } : {}) } : raw;
    normalized = normalizeSessionProjectionMessage(sessionID, native);
    if (normalized) {
      const rawTime = record(raw.time), actualTime = { ...record(normalized.info.time) };
      // The shared UI normalizer uses created:0 as an empty transport placeholder.
      // Native overview must not turn that placeholder into measured timing.
      if (typeof rawTime.created !== 'number' || !Number.isFinite(rawTime.created)) delete actualTime.created;
      normalized = { ...normalized, info: { ...normalized.info, time: actualTime } as ContextUsageEntry['info'], contextAuthority: { origin: message.contextOrigin ?? 'projection' } };
    }
  }
  if (normalized) {
    const slim = (message.content ?? []).some(part => part.slim === true);
    // Preserve wire fields (including slim markers and unknown future fields) for raw JSON.
    // Canonical info/parts is a shared render projection, never advertised as wire JSON.
    const received = overlaid ? { received: raw, currentContent: message.content ?? [], ...(message.contextLive && message.error ? { liveError: message.error } : {}) } : raw;
    normalized = { ...normalized, ...(message.contextLive && message.error ? { info: { ...normalized.info, error: { type: 'error', message: message.error } } } : {}), contextAuthority: { origin: message.contextOrigin ?? 'projection', slim }, contextReceived: received };
  }
  entries.set(message, { sessionID, entry: normalized }); return normalized;
}

/** The Web overview observes the CURRENT LOADED repository window, not the full session database. */
export function contextUsageSnapshotFromChat(options: {
  scope: ContextUsageScope;
  messages: readonly Message[];
  messagesResolved: boolean;
  historyError?: string;
  session: ContextUsageSnapshot['session'];
  providers: ContextUsageSnapshot['providers'];
}): ContextUsageSnapshot {
  if (!options.messagesResolved) throw new Error(options.historyError || 'Context overview message authority is unresolved');
  if (options.historyError) throw new Error(options.historyError);
  if (options.session.id !== options.scope.sessionID || !options.scope.hostID || !options.scope.directory || !Number.isSafeInteger(options.scope.generation)) throw new Error('Context overview snapshot scope mismatch');
  const messages: ContextUsageEntry[] = [];
  const seen = new Set<string>();
  for (const message of options.messages) {
    const entry = contextUsageEntryFromNative(message, options.scope.sessionID);
    if (entry) {
      if (seen.has(entry.info.id)) throw new Error('Duplicate context overview message');
      seen.add(entry.info.id); messages.push(entry);
    }
  }
  return { scope: { ...options.scope }, session: options.session, providers: options.providers, messages };
}

/** Existing SSE reducer result → one narrow overview patch. No list scan, new SSE or read. */
export function contextUsagePatchFromNative(scope: ContextUsageScope, value: Message | readonly Message[]) {
  const messages = 'id' in value ? [value] : value;
  const entries: ContextUsageEntry[] = [];
  for (const message of messages) {
    const entry = contextUsageEntryFromNative(message, scope.sessionID);
    if (entry) entries.push(entry);
  }
  return { kind: 'patch' as const, scope, entries };
}

/** One overview route, one captured Chat. Only structural commits read the loaded window. */
export function createContextUsageSourceAdapter(options: {
  scope: ContextUsageScope;
  current: () => boolean;
  read: () => Omit<Parameters<typeof contextUsageSnapshotFromChat>[0], 'scope'>;
}) {
  const scope = Object.freeze({ ...options.scope });
  let alive = true, structure: Map<string, string> | undefined;
  const current = () => alive && options.current();
  function snapshot() {
    if (!current()) return null;
    const value = contextUsageSnapshotFromChat({ ...options.read(), scope });
    structure = new Map(value.messages.map(entry => [entry.info.id, contextUsageEntryStructureKey(entry)]));
    return { kind: 'snapshot' as const, value };
  }
  return {
    snapshot,
    /** One batched commit from the existing Chat writer, not one signal write per delta. */
    commit(messages: readonly Message[]) {
      if (!current()) return null;
      const patch = contextUsagePatchFromNative(scope, messages);
      const known = structure;
      if (!known || patch.entries.some(entry => known.get(entry.info.id) !== contextUsageEntryStructureKey(entry))) return snapshot();
      return patch;
    },
    dispose() { alive = false; structure?.clear(); structure = undefined; },
  };
}
