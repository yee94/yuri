import { record, text, type Message, type Row } from './model';
import type { Part } from '../ui/src/lib/opencode/v2-types';
import { resolveActivityExpansionDisposition, resolveDefaultActivityExpanded, resolveTurnActivityPresentation } from '../ui/src/components/chat/lib/activityExpansion';
import { hasVisibleText } from '../ui/src/components/chat/message/partUtils';
import { collectConsecutiveProcessTools, isProcessSuccessorPart, isProcessGroupActive, summarizeProcessTools, summarizeUsedToolDiffs } from '../ui/src/components/chat/message/parts/processToolGrouping';
import { isProcessGroupTool, isSkillGroupTool, isToolPartActive } from '../ui/src/components/chat/message/parts/toolRenderUtils';
import { collectConsecutiveSkillTools, getSkillNameFromToolPart, summarizeSkillNames } from '../ui/src/components/chat/message/parts/skillToolGrouping';
import { projectTurnRecords } from '../ui/src/components/chat/lib/turns/projectTurnRecords';
import { projectTurnIndexes } from '../ui/src/components/chat/lib/turns/projectTurnIndexes';
import type { ChatMessageEntry, TurnRecord } from '../ui/src/components/chat/lib/turns/types';
import { getNormalizedMessageForDisplay } from '../ui/src/components/chat/lib/messageDisplayNormalization';
import { normalizeUserDisplayParts } from '../ui/src/components/chat/message/normalizeUserDisplayParts';
import { isRestartNotice } from '../ui/src/components/chat/message/assistantErrorPresentation';
import { splitTimelineRenderEntries } from '../ui/src/components/chat/lib/turns/timelineRenderEntries';
import { activityTaskAvatarSeeds, slimActivityMessageIds } from '../ui/src/components/chat/message/parts/activityHeaderModel';
import { projectionToolTime } from '../ui/src/sync/session-tool-content';

export type NativeBodyRow = { key: string; head: Message; tail: Message; messages: Message[]; startedAt?: number; isLastTurn: boolean; turn?: TurnRecord };
export type NativeBodyPart = { key: string; messageID: string; source: Row; projection: Part };
export type NativeBodyNode = { kind: 'part'; key: string; part: NativeBodyPart } | { kind: 'process'; key: string; parts: NativeBodyPart[]; active: boolean; counts: ReturnType<typeof summarizeProcessTools>; diffs: ReturnType<typeof summarizeUsedToolDiffs> } | { kind: 'skill'; key: string; parts: NativeBodyPart[]; active: boolean; names: ReturnType<typeof summarizeSkillNames> };

// Immutable Message identity owns adaptation; WeakMap entries leave with their source.
const entries = new WeakMap<Message, ChatMessageEntry>();
export function nativeMessageEntry(message: Message): ChatMessageEntry {
  const cached = entries.get(message);
  if (cached) return cached;
  const raw = message.projectionInfo ?? {};
  const nativeType = text(raw.nativeType) || text(raw.type);
  const info = { ...raw, id: message.id, sessionID: text(raw.sessionID), role: message.role === 'compaction' ? 'assistant' : message.role,
    metadata: message.role === 'assistant' ? undefined : raw.metadata,
    ...(nativeType ? { nativeType } : {}), ...(message.role === 'compaction' ? { clientRole: 'compaction' } : {}),
    modelID: message.modelID, providerID: message.providerID, agent: message.agent,
    model: { modelID: message.modelID, providerID: message.providerID, variant: message.variant },
    finish: message.finish, error: raw.error || (message.error ? { message: message.error } : undefined), time: message.time ?? {}, tokens: message.tokens };
  let parts = sourceParts(message).map((source, index) => projectPart(message, source, index).projection);
  if (nativeType === 'synthetic') parts = parts.map(part => ({ ...part, synthetic: true }));
  if (nativeType === 'shell') parts = [{ id: `${message.id}:text:0`, sessionID: info.sessionID, messageID: message.id, type: 'text', text: text(raw.command), shellAction: { command: text(raw.command), output: text(record(raw.output).output), status: raw.status === 'running' ? 'running' : raw.exit === 0 ? 'completed' : 'error' } } as Part];
  const entry = getNormalizedMessageForDisplay({ info: info as ChatMessageEntry['info'], parts });
  entries.set(message, entry);
  return entry;
}
export function nativeMessageRole(message: Message): string {
  const info = nativeMessageEntry(message).info;
  return info.clientRole ?? info.role;
}
export function nativeRowTurns(rows: readonly NativeBodyRow[]): TurnRecord[] {
  return [...new Set(rows.flatMap(row => row.turn ? [row.turn] : []))];
}
/** Never fabricate a merged Message id. Header and actions retain real source records. */
export function nativeBodyRows(messages: readonly Message[], previousRows: NativeBodyRow[] = []): NativeBodyRow[] {
  const rows: NativeBodyRow[] = [];
  const projection = projectTurnRecords(messages.map(nativeMessageEntry), { showTextJustificationActivity: true,
    previousProjection: previousRows.length ? projectTurnIndexes(nativeRowTurns(previousRows)) : undefined });
  const sourceByID = new Map(messages.map(message => [message.id, message]));
  const timeline = splitTimelineRenderEntries({ messages: messages.map(nativeMessageEntry), turns: projection.turns,
    ungroupedMessageIds: projection.ungroupedMessageIds ?? new Set(), streamingTurns: [], lastTurnId: projection.turns.at(-1)?.turnId ?? null });
  for (const item of [...timeline.history, ...timeline.tail]) {
    if (item.kind === 'ungrouped') {
      const message = sourceByID.get(item.message.info.id)!;
      rows.push({ key: message.id, head: message, tail: message, messages: [message], isLastTurn: false });
      continue;
    }
    const turn = item.turn;
    for (const entry of turn.messages) {
      const message = sourceByID.get(entry.messageId)!;
      if (entry.message.info.nativeType === 'synthetic' && !isRestartNotice(entry.message.info) && normalizeUserDisplayParts(entry.message.parts).length === 0) continue;
      const previous = rows.at(-1);
      if (entry.role === 'assistant' && previous && nativeMessageRole(previous.head) === 'assistant' && previous.turn === turn) {
        previous.messages.push(message); previous.tail = message;
      } else rows.push({ key: message.id, head: message, tail: message, messages: [message], startedAt: turn.startedAt, isLastTurn: item.isLastTurn, turn });
    }
  }
  const previousByMessage = new Map(previousRows.flatMap(row => row.messages.map(message => [message.id, row] as const)));
  const presentIDs = new Set(messages.map(message => message.id));
  const usedKeys = new Set<string>();
  const stable = rows.map(row => {
    const previous = previousByMessage.get(row.head.id) ?? row.messages.map(message => previousByMessage.get(message.id)).find(Boolean);
    if (!previous || usedKeys.has(previous.key)) return row;
    // A split keeps the old key only on the fragment containing its identity.
    if (!row.messages.some(message => message.id === previous.key) && presentIDs.has(previous.key)) return row;
    usedKeys.add(previous.key);
    row.key = previous.key;
    return row.turn === previous.turn && row.startedAt === previous.startedAt && row.isLastTurn === previous.isLastTurn && row.messages.length === previous.messages.length && row.messages.every((message, index) => message === previous.messages[index]) ? previous : row;
  });
  return stable.length === previousRows.length && stable.every((row, index) => row === previousRows[index]) ? previousRows : stable;
}
function sourceParts(message: Message): Row[] {
  const files = message.files.filter(part => !message.content?.includes(part)).map(part => ({ ...part, type: 'file' }));
  if (message.content?.length) return [...message.content, ...message.cards.filter(part => !message.content!.includes(part)), ...files];
  // Legacy/contact records have no raw content order. Never use this fallback when it exists.
  return [...(message.text ? [{ type: 'text', text: message.text }] : []), ...(message.reasoning ? [{ type: 'reasoning', text: message.reasoning }] : []), ...message.tools, ...message.cards, ...files];
}
function projectPart(message: Message, source: Row, index: number): NativeBodyPart {
  const key = `${message.id}:${text(source.id) || `${text(source.type)}:${typeof source.ordinal === 'number' ? source.ordinal : index}`}`;
  const base = { id: key, messageID: message.id, sessionID: '' };
  let projection: Part;
  if (source.type === 'text') projection = { ...source, ...base, type: 'text', text: text(source.text) };
  else if (source.type === 'reasoning') projection = { ...source, ...base, type: 'reasoning', text: text(source.text) };
  else if (source.type === 'tool') {
    const state = record(source.state);
    projection = { ...source, ...base, type: 'tool', callID: text(source.callID) || key, tool: text(source.name) || text(source.tool), state: { ...state, status: text(state.status), input: state.input, ...(source.time !== undefined ? { time: projectionToolTime(source.time) } : {}) }, metadata: record(source.metadata) };
  } else if (source.type === 'file') projection = { ...source, ...base, type: 'file', mime: text(source.mime), url: text(source.url) || text(source.uri) };
  else projection = { ...source, ...base } as Part;
  return { key, messageID: message.id, source, projection };
}
function nodes(parts: NativeBodyPart[], live: boolean): NativeBodyNode[] {
  const result: NativeBodyNode[] = [];
  const successor: boolean[] = [];
  successor[parts.length] = false;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!.projection;
    successor[index] = successor[index + 1]! || isProcessSuccessorPart({ type: part.type, toolName: part.type === 'tool' ? part.tool : undefined });
  }
  for (let index = 0; index < parts.length;) {
    const part = parts[index]!;
    if (part.projection.type === 'tool' && isProcessGroupTool(part.projection.tool)) {
      const group = collectConsecutiveProcessTools(parts, index, entry => entry.projection.type === 'tool' ? entry.projection.tool : undefined);
      const projected = group.items.map(part => part.projection);
      const following = successor[group.end]!;
      result.push({ kind: 'process', key: `process:${part.key}`, parts: group.items,
        active: isProcessGroupActive({ parts: projected, hasFollowingOtherType: following, isTurnLive: live }),
        counts: summarizeProcessTools(projected.map(part => part.type === 'tool' ? part.tool : '')), diffs: summarizeUsedToolDiffs(projected) });
      index = group.end;
    } else if (part.projection.type === 'tool' && isSkillGroupTool(part.projection.tool)) {
      const group = collectConsecutiveSkillTools(parts, index, entry => entry.projection.type === 'tool' ? entry.projection.tool : undefined);
      result.push({ kind: 'skill', key: `skill:${part.key}`, parts: group.items,
        active: group.items.some(entry => isToolPartActive(entry.projection)), names: summarizeSkillNames(group.items.map(entry => getSkillNameFromToolPart(entry.projection))) });
      index = group.end;
    } else { result.push({ kind: 'part', key: part.key, part }); index++; }
  }
  return result;
}
export function nativeBodyPlan(row: NativeBodyRow, options: { live?: boolean; showReasoning?: boolean; mode?: 'sorted' | 'live'; activityMode?: 'collapsed' | 'summary' } = {}) {
  const all = row.messages.flatMap(message => {
    const source = new Map(sourceParts(message).map((part, index) => { const projected = projectPart(message, part, index); return [projected.key, projected] as const; }));
    const entry = nativeMessageEntry(message);
    const parts = nativeMessageRole(message) === 'user' ? normalizeUserDisplayParts(entry.parts) : entry.parts;
    return parts.map(projection => {
      const original = source.get(projection.id);
      const originalSource = original?.source ?? projection as unknown as Row;
      return { key: projection.id, messageID: message.id, projection,
        source: projection.type === 'text' && projection.text !== originalSource.text ? { ...originalSource, text: projection.text } : originalSource };
    });
  });
  const visible = all.filter(part => {
    if (part.source.type === 'text') return hasVisibleText(text(part.source.text));
    if (part.source.type === 'reasoning') return options.showReasoning !== false && hasVisibleText(text(part.source.text));
    return !['step-start', 'step-finish'].includes(text(part.source.type));
  });
  const turn = row.turn ?? projectTurnRecords(row.messages.map(nativeMessageEntry), { showTextJustificationActivity: true }).turns[0];
  const activityIDs = new Set(turn?.activityParts.map(part => part.part.id));
  const rowMessageIDs = new Set(row.messages.map(message => message.id));
  const rowActivity = turn?.activityParts.filter(part => rowMessageIDs.has(part.messageId)) ?? [];
  const compaction = turn?.activityPresentationKind === 'compaction';
  const hasCompactionPlaceholder = compaction && !turn.assistantMessages.length && (turn.completionDisposition !== 'active' || row.isLastTurn && options.live === true);
  const hasActivity = options.mode !== 'live' && (hasCompactionPlaceholder || nativeMessageRole(row.head) === 'assistant' && !!(compaction || rowActivity.length));
  const activityParts = hasActivity ? visible.filter(part => activityIDs.has(part.key)) : [];
  const inline = hasActivity ? visible.filter(part => !activityIDs.has(part.key)) : visible;
  const confirmed = turn?.hasConfirmedFinalBody ?? false;
  const disposition = turn?.completionDisposition ?? 'abnormal';
  const presentation = resolveTurnActivityPresentation({ completionDisposition: disposition, isLastTurn: row.isLastTurn, sessionIsWorking: options.live === true });
  const live = presentation.completionDisposition === 'active';
  const expansion = resolveActivityExpansionDisposition({ isLastTurn: row.isLastTurn, turnCompletionDisposition: disposition, headerPresentationDisposition: presentation.completionDisposition, hasAssistantMessages: (turn?.assistantMessages.length ?? 0) > 0 });
  let inlineNodes: NativeBodyNode[];
  if (options.mode === 'live') {
    const byMessage = new Map<string, NativeBodyPart[]>();
    for (const part of inline) {
      const bucket = byMessage.get(part.messageID);
      if (bucket) bucket.push(part); else byMessage.set(part.messageID, [part]);
    }
    inlineNodes = [...byMessage.values()].flatMap(parts => nodes(parts, live));
  } else inlineNodes = nodes(inline, live);
  return { activity: nodes(activityParts, live), inline: inlineNodes, hasActivity: hasActivity && (compaction || rowActivity.length > 0), compaction, active: live, foldInline: compaction && options.mode !== 'live',
    header: { agents: activityTaskAvatarSeeds(rowActivity), diffs: summarizeUsedToolDiffs(rowActivity.filter(part => part.kind === 'tool').map(part => part.part)) },
    materializationMessageIDs: slimActivityMessageIds(rowActivity),
    locked: live, defaultExpanded: (row.isLastTurn && options.live === true) || resolveDefaultActivityExpanded(expansion, options.activityMode ?? 'collapsed', { isLastTurn: row.isLastTurn, hasConfirmedFinalBody: confirmed }),
    durationMs: turn?.durationMs };
}
