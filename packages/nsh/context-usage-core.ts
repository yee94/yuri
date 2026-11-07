import type { ChatMessageEntry } from '../ui/src/components/chat/lib/turns/types';
import { projectTurnRecords } from '../ui/src/components/chat/lib/turns/projectTurnRecords';
import { deriveMessageRole } from '../ui/src/components/chat/message/messageRole';
import { computeAssistantTps, computeAssistantTpsByStep, formatAssistantTps, type AssistantTpsInput } from '../ui/src/components/chat/message/assistantTps';
import { computeCacheHitRate } from '../ui/src/stores/utils/tokenUtils';
import { sumContextTokenRecord } from '../ui/src/sync/context-token-baseline';
import { record, text } from './model';

export type ContextUsageEntry = ChatMessageEntry & { contextAuthority?: { origin: 'projection' | 'stream'; slim?: boolean }; contextReceived?: Record<string, unknown> };
export type ContextUsageScope = { hostID: string; generation: number; sessionID: string; directory: string };
export type ContextUsageProvider = { id: string; name?: string; models: { id: string; name?: string; limit?: { context?: number } }[] };
export type ContextUsageSnapshot = {
  scope: ContextUsageScope;
  session: { id: string; title?: string; time?: { created?: number } };
  /** Canonical raw info+parts, oldest→newest, exactly the loaded Web repository window. */
  messages: ContextUsageEntry[];
  providers: ContextUsageProvider[];
};
export type ContextUsageTokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };
type Buckets = { user: number; assistant: number; tool: number; other: number };
const zero = (): Buckets => ({ user: 0, assistant: 0, tool: 0, other: 0 });
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Same legacy number/part fallback as Web overview; the token sum itself stays shared. */
export function contextUsageTokens(entry: ContextUsageEntry): ContextUsageTokens {
  const info = record(entry.info), candidate = info.tokens !== undefined ? info.tokens : record(entry.parts.find(part => record(part).tokens !== undefined)).tokens;
  const source = record(candidate), cache = record(source.cache);
  const input = count(source.input), output = count(source.output), reasoning = count(source.reasoning), cacheRead = count(cache.read), cacheWrite = count(cache.write);
  return { input, output, reasoning, cacheRead, cacheWrite, total: typeof candidate === 'number' ? count(candidate) : sumContextTokenRecord({ input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } }) };
}

// Web's context composition is explicitly a character/4 estimate, not measured token usage.
function length(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + length(item), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((sum, item) => sum + length(item), 0);
  return 0;
}
function firstString(...values: unknown[]): string { return values.find(value => typeof value === 'string' && value.trim()) as string ?? ''; }
export function contextUsageKnownTokens(entry: ContextUsageEntry) {
  const info = record(entry.info), source = info.tokens !== undefined ? info.tokens : record(entry.parts.find(part => record(part).tokens !== undefined)).tokens;
  const usage = record(source), cache = record(usage.cache), finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return { input: finite(usage.input), output: finite(usage.output), reasoning: finite(usage.reasoning), cacheRead: finite(cache.read), cacheWrite: finite(cache.write), total: finite(source) || [usage.input, usage.output, usage.reasoning, cache.read, cache.write].every(finite) };
}
function contribution(entry: ContextUsageEntry) {
  const role = deriveMessageRole(entry.info), bucket: keyof Buckets = role.isUser ? 'user' : role.role === 'assistant' ? 'assistant' : role.role === 'tool' ? 'tool' : 'other';
  const chars = zero();
  for (const part of entry.parts) {
    const p = record(part), call = record(p.call), source = record(p.source);
    if (p.type === 'reasoning') { chars.assistant += length(p.text) + length(p.content); continue; }
    const direct = firstString(p.text, p.content, p.value, source.value, record(source.text).value);
    if (p.type === 'tool' || bucket === 'tool') chars.tool += length(p.input) + length(p.output) + length(p.error) + length(call.input) + length(call.output) + length(call.error) + length(p.raw) + Math.round(length(p.metadata) * .25) + Math.round(length(p.state) * .1);
    else chars[bucket] += direct.length;
  }
  const info = record(entry.info);
  return { role: role.role, isUser: role.isUser, chars, tokens: contextUsageTokens(entry), cost: role.role === 'assistant' ? count(info.cost) : 0, known: contextUsageKnownTokens(entry), costKnown: typeof info.cost === 'number' && Number.isFinite(info.cost) && info.cost >= 0, partial: entry.contextAuthority?.origin === 'stream' || entry.contextAuthority?.slim === true };
}
type Contribution = ReturnType<typeof contribution>;
type TurnUsage = { ids: string[]; finalID?: string; rate: number | null; generated: number; duration: number; settled: boolean };
export type ContextUsageView = {
  sessionTitle?: string; createdAt: number | null; lastActivityAt: number | null;
  messagesCount: number; userMessagesCount: number; assistantMessagesCount: number;
  providerModel: { providerName: string; modelName: string; contextLimit: number | null };
  tokenBreakdown: ContextUsageTokens; usagePercent: number; cacheHitRate: ReturnType<typeof computeCacheHitRate>;
  totalAssistantCost: number; sessionTpsLabel: string | null; lastAssistantTpsLabel: string | null;
  breakdown: Buckets; breakdownTotal: number; contextLimit: number | null;
};
export const contextUsageScopeKey = (scope: ContextUsageScope) => JSON.stringify([scope.hostID, scope.generation, scope.directory, scope.sessionID]);
export const contextUsageEntryStructureKey = (entry: ContextUsageEntry) => {
  const info = record(entry.info);
  return JSON.stringify([deriveMessageRole(entry.info).role, ...['parentID', 'nativeType', 'clientRole', 'userMessageMarker', 'origin', 'source'].map(field => info[field])]);
};

/** Page-local incremental projection. Drafts are not an input; text/token patches touch one turn only. */
export function createContextUsageOwner(scope: ContextUsageScope, options: { showAssistantTps: boolean; current: () => boolean; changed?: () => void }) {
  const captured = Object.freeze({ ...scope }), key = contextUsageScopeKey(captured);
  const entries = new Map<string, ContextUsageEntry>(), contributions = new Map<string, Contribution>(), positions = new Map<string, number>();
  const turnByMessage = new Map<string, string>(), turns = new Map<string, TurnUsage>(), tps = new Map<string, string>();
  let snapshot: Pick<ContextUsageSnapshot, 'session'> | undefined, order: string[] = [], reversed: string[] = [], chars = zero();
  let users = 0, assistants = 0, cost = 0, unknownCosts = 0, partial = 0, contextID: string | undefined, systemID: string | undefined, latestAssistantID: string | undefined;
  let generated = 0, duration = 0, loading = false, error = '', alive = true;
  let providerIndex = new Map<string, ContextUsageView['providerModel']>();
  let showTps = options.showAssistantTps;
  const operations = { messageVisits: 0, turnVisits: 0, resets: 0, jsonBuilds: 0 };
  const current = () => alive && options.current();
  const notify = () => options.changed?.();
  function add(value: Contribution, sign: 1 | -1) {
    for (const bucket of ['user', 'assistant', 'tool', 'other'] as const) chars[bucket] += sign * value.chars[bucket];
    users += sign * Number(value.isUser); assistants += sign * Number(value.role === 'assistant'); cost += sign * value.cost;
    unknownCosts += sign * Number(value.role === 'assistant' && !value.costKnown); partial += sign * Number(value.partial);
  }
  function updateTurn(id: string, ids: string[]) {
    const previous = turns.get(id);
    if (previous?.settled) { generated -= previous.generated; duration -= previous.duration; }
    ids.forEach(messageID => tps.delete(messageID));
    operations.turnVisits += ids.length;
    const projected = projectTurnRecords(ids.map(messageID => entries.get(messageID)!));
    // Membership was fixed by the initial authoritative projection. Structural changes use reset().
    const turn = projected.turns[0];
    const steps: AssistantTpsInput[] = (turn?.assistantMessages ?? []).map(({ info }) => ({ createdAt: info.time.created, streamedAt: info.time.streamed, outputTokens: info.tokens?.output, reasoningTokens: info.tokens?.reasoning }));
    const rates = computeAssistantTpsByStep(steps);
    rates.forEach((rate, index) => { if (rate !== null) tps.set(turn!.assistantMessageIds[index], formatAssistantTps(rate)); });
    const rate = rates.at(-1) ?? null;
    const next: TurnUsage = { ids, finalID: turn?.assistantMessageIds.at(-1), rate, generated: steps.reduce((sum, step) => sum + count(step.outputTokens) + count(step.reasoningTokens), 0), duration: steps.reduce((sum, step) => sum + Math.max(0, (step.streamedAt ?? 0) - (step.createdAt ?? 0)), 0), settled: !!turn && turn.completionDisposition !== 'active' && rate !== null };
    turns.set(id, next);
    if (next.settled) { generated += next.generated; duration += next.duration; }
  }
  function validate(entry: ContextUsageEntry) {
    if (!entry.info.id || entry.info.sessionID !== captured.sessionID || !entry.info.time || !Array.isArray(entry.parts)) throw new Error('Context overview message escaped captured session');
  }
  function reset(value: ContextUsageSnapshot) {
    if (!current()) return;
    contextUsageSnapshotFrom(value);
    if (contextUsageScopeKey(value.scope) !== key || value.session.id !== captured.sessionID) throw new Error('Context overview snapshot escaped captured scope');
    const seen = new Set<string>();
    for (const entry of value.messages) { validate(entry); if (seen.has(entry.info.id)) throw new Error('Duplicate context overview message'); seen.add(entry.info.id); }
    entries.clear(); contributions.clear(); positions.clear(); turnByMessage.clear(); turns.clear(); tps.clear();
    chars = zero(); users = 0; assistants = 0; cost = 0; unknownCosts = 0; partial = 0; contextID = undefined; systemID = undefined; latestAssistantID = undefined; generated = 0; duration = 0;
    snapshot = { session: value.session }; order = value.messages.map(entry => entry.info.id); reversed = [...order].reverse(); operations.resets++;
    value.messages.forEach((entry, index) => {
      operations.messageVisits++; entries.set(entry.info.id, entry); positions.set(entry.info.id, index);
      const item = contribution(entry); contributions.set(entry.info.id, item); add(item, 1);
      if (item.role === 'assistant') latestAssistantID = entry.info.id;
      if (item.role === 'assistant' && item.tokens.total > 0) contextID = entry.info.id;
      if (item.isUser && typeof record(entry.info).system === 'string') systemID = entry.info.id;
    });
    providerIndex = new Map();
    for (const provider of value.providers) for (const model of provider.models) providerIndex.set(JSON.stringify([provider.id, model.id]), { providerName: provider.name || provider.id || '-', modelName: model.name || model.id || '-', contextLimit: typeof model.limit?.context === 'number' ? model.limit.context : null });
    if (showTps) {
      for (const turn of projectTurnRecords(value.messages).turns) {
        const ids = turn.messages.map(message => message.messageId);
        ids.forEach(id => turnByMessage.set(id, turn.turnId)); updateTurn(turn.turnId, ids);
      }
    }
    loading = false; error = ''; notify();
  }
  function patch(value: { scope: ContextUsageScope; entries: ContextUsageEntry[] }) {
    if (!current()) return;
    if (!snapshot || contextUsageScopeKey(value.scope) !== key) throw new Error('Context overview patch escaped captured scope');
    for (const entry of value.entries) {
      validate(entry);
      const before = contributions.get(entry.info.id);
      if (!before || before.role !== deriveMessageRole(entry.info).role) throw new Error('Structural context overview changes require reset');
      if (contextUsageEntryStructureKey(entries.get(entry.info.id)!) !== contextUsageEntryStructureKey(entry)) throw new Error('Structural context overview identity changes require reset');
    }
    const dirtyTurns = new Set<string>();
    for (const entry of value.entries) {
      if (entries.get(entry.info.id) === entry) continue;
      operations.messageVisits++;
      add(contributions.get(entry.info.id)!, -1); const item = contribution(entry); add(item, 1);
      entries.set(entry.info.id, entry); contributions.set(entry.info.id, item);
      if (item.role === 'assistant' && item.tokens.total > 0 && (!contextID || positions.get(entry.info.id)! >= positions.get(contextID)!)) contextID = entry.info.id;
      else if (contextID === entry.info.id && item.tokens.total <= 0) contextID = [...order].reverse().find(id => contributions.get(id)!.role === 'assistant' && contributions.get(id)!.tokens.total > 0);
      if (item.isUser && typeof record(entry.info).system === 'string' && (!systemID || positions.get(entry.info.id)! >= positions.get(systemID)!)) systemID = entry.info.id;
      else if (systemID === entry.info.id && typeof record(entry.info).system !== 'string') systemID = [...order].reverse().find(id => contributions.get(id)!.isUser && typeof record(entries.get(id)!.info).system === 'string');
      const turnID = turnByMessage.get(entry.info.id); if (turnID) dirtyTurns.add(turnID);
    }
    dirtyTurns.forEach(id => updateTurn(id, turns.get(id)!.ids));
    error = ''; loading = false; notify();
  }
  function view(): ContextUsageView | undefined {
    if (!snapshot) return;
    const context = contextID ? entries.get(contextID) : undefined;
    const tokens = contextID ? contributions.get(contextID)!.tokens : { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const providerID = text(record(context?.info).providerID), modelID = text(record(context?.info).modelID);
    const model = providerIndex.get(JSON.stringify([providerID, modelID])) ?? { providerName: providerID || '-', modelName: modelID || '-', contextLimit: null };
    const system = systemID ? text(record(entries.get(systemID)!.info).system) : '';
    const breakdown = { user: order.length ? Math.ceil((chars.user + system.length) / 4) : 0, assistant: Math.ceil(chars.assistant / 4), tool: Math.ceil(chars.tool / 4), other: 0 };
    breakdown.other = Math.max(0, tokens.input - breakdown.user - breakdown.assistant - breakdown.tool);
    const contextTurn = contextID ? turns.get(turnByMessage.get(contextID) ?? '') : undefined;
    const rate = computeAssistantTps([{ createdAt: 0, streamedAt: duration, outputTokens: generated }]);
    return { sessionTitle: snapshot.session.title, messagesCount: order.length, userMessagesCount: users, assistantMessagesCount: assistants,
      createdAt: snapshot.session.time?.created ?? entries.get(order[0])?.info.time?.created ?? null,
      lastActivityAt: entries.get(order.at(-1)!)?.info.time?.created ?? snapshot.session.time?.created ?? null,
      providerModel: model, contextLimit: model.contextLimit, tokenBreakdown: tokens,
      usagePercent: model.contextLimit && model.contextLimit > 0 ? Math.min(999, tokens.total / model.contextLimit * 100) : 0,
      cacheHitRate: computeCacheHitRate({ input: tokens.input, cache: { read: tokens.cacheRead, write: tokens.cacheWrite } }), totalAssistantCost: cost,
      sessionTpsLabel: showTps && rate !== null ? formatAssistantTps(rate) : null,
      lastAssistantTpsLabel: contextTurn?.finalID ? tps.get(contextTurn.finalID) ?? null : null,
      breakdown, breakdownTotal: breakdown.user + breakdown.assistant + breakdown.tool + breakdown.other };
  }
  return { scope: captured, reset, patch, view, order: () => reversed, message: (id: string) => entries.get(id), tps: (id: string) => tps.get(id) ?? null,
    known() {
      const latest = contributions.get(contextID ?? latestAssistantID ?? ''), empty = !!snapshot && assistants === 0;
      const tokens = latest?.known ?? { input: empty, output: empty, reasoning: empty, cacheRead: empty, cacheWrite: empty, total: empty };
      return { tokens, cost: !!snapshot && unknownCosts === 0, composition: tokens.input && partial === 0, partial: partial > 0 || unknownCosts > 0 || Object.values(tokens).some(known => !known) };
    },
    setShowAssistantTps(value: boolean) {
      if (!current() || value === showTps) return;
      showTps = value; turns.clear(); turnByMessage.clear(); tps.clear(); generated = 0; duration = 0;
      if (value && snapshot) for (const turn of projectTurnRecords(order.map(id => entries.get(id)!)).turns) {
        const ids = turn.messages.map(message => message.messageId); ids.forEach(id => turnByMessage.set(id, turn.turnId)); updateTurn(turn.turnId, ids);
      }
      notify();
    },
    json(id: string) { const entry = entries.get(id); if (!entry) return ''; operations.jsonBuilds++; return JSON.stringify(entry.contextReceived ?? { info: entry.info, parts: entry.parts }, null, 2); },
    state: () => ({ loading, error, resolved: !!snapshot }), operations: () => ({ ...operations }),
    loading() { if (current()) { loading = true; error = ''; notify(); } },
    failed(cause: unknown) { if (current()) { loading = false; error = cause instanceof Error ? cause.message : String(cause); notify(); } },
    dispose() { alive = false; entries.clear(); contributions.clear(); positions.clear(); providerIndex.clear(); turns.clear(); turnByMessage.clear(); tps.clear(); snapshot = undefined; order = []; reversed = []; },
  };
}
export type ContextUsageOwner = ReturnType<typeof createContextUsageOwner>;

/** Narrow JSON boundary for a canonical root-owner snapshot, never a slim native Message cast. */
export function contextUsageSnapshotFrom(value: unknown): ContextUsageSnapshot {
  function valid(input: unknown): input is ContextUsageSnapshot {
    const root = record(input), scope = record(root.scope), session = record(root.session);
    if (![scope.hostID, scope.directory, scope.sessionID, session.id].every(item => typeof item === 'string' && item.length > 0) || !Number.isSafeInteger(scope.generation) || scope.sessionID !== session.id) return false;
    if (!Array.isArray(root.messages) || !Array.isArray(root.providers)) return false;
    return root.messages.every(raw => {
      const entry = record(raw), info = record(entry.info);
      return typeof info.id === 'string' && !!info.id && info.sessionID === scope.sessionID && typeof info.role === 'string' && !!info.time && typeof info.time === 'object' && Array.isArray(entry.parts) && entry.parts.every(rawPart => { const part = record(rawPart); return typeof part.type === 'string' && typeof part.id === 'string'; });
    }) && root.providers.every(raw => { const provider = record(raw); return typeof provider.id === 'string' && Array.isArray(provider.models) && provider.models.every(rawModel => typeof record(rawModel).id === 'string'); });
  }
  if (!valid(value)) throw new Error('Invalid canonical context overview snapshot');
  return value;
}
