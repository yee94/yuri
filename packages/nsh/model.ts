import type { ScopedReferenceDocument } from './composer-references';

export type Row = Record<string, unknown>;
export const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
export const text = (value: unknown): string => typeof value === 'string' ? value : '';
export const list = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
export const unwrap = (value: unknown): unknown => record(value).data ?? value;
export const nameOf = (path: string): string => path.replace(/\/$/, '').split('/').pop() || path;
export const id = (): string => `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
export type Connection = { id: string; label: string; url: string; lastUsedAt: number; authorizationID?: string };
export type Project = { id: string; name: string; path: string };
export type Session = { id: string; title: string; directory: string; updated: number; parentID?: string };
export type ChatTarget = { kind: 'session' | 'assistant'; id: string; title: string; directory: string };
export type Message = { id: string; role: string; text: string; reasoning: string; tools: Row[]; cards: Row[]; files: Row[]; error: string; ordinal?: number; content?: Row[]; projectionInfo?: Row; modelID?: string; providerID?: string; modelName?: string; variant?: string; agent?: string; finish?: string; time?: { created?: number; streamed?: number; completed?: number }; tokens?: { output?: number; reasoning?: number }; contextRaw?: Row; contextOrigin?: 'projection' | 'stream'; contextLive?: boolean; contextContent?: readonly Row[] };
export type MessagePage = { messages: Message[]; cursor: string | null; complete: boolean; generation?: number; revision?: number };
export type FormAnswer = Record<string, string | number | boolean | string[]>;
export type Attachment = { uri: string; name: string; mime: string };
export type SlashCommand = { name: string; text: string };
export type CompiledSubmission = {
  text: string;
  files?: Array<{ uri: string; name?: string }>;
  agents?: Array<{ name: string }>;
  skills?: Array<{ id: string }>;
  metadata?: Row;
};
export type Submission = { id: string; text: string; files: Attachment[]; delivery: 'queue' | 'steer'; uncertain: boolean; command?: SlashCommand; inputMode?: 'normal' | 'shell'; compiled?: CompiledSubmission; preparedText?: string; references?: ScopedReferenceDocument };
export type QueueEdit = { id: string; text: string; files: Attachment[] };
export function slashCommand(value: string): SlashCommand | undefined {
  const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
  return match ? { name: match[1]!, text: match[2] ?? '' } : undefined;
}
export type RuntimeEvent = { key: 'global' | 'chat'; type: string; body: Row; directory: string; id?: string; created?: number };

export function projectsFrom(settings: unknown): Project[] {
  return list(record(unwrap(settings)).projects).map(p => ({ id: text(p.id), path: text(p.path), name: text(p.label) || text(p.name) || nameOf(text(p.path)) })).filter(p => p.id && p.path);
}
export function sessionsFrom(snapshot: unknown): Session[] {
  const value = record(snapshot);
  if (value.available !== true || !Array.isArray(value.directories)) throw new Error('Session index unavailable');
  return list(value.directories).flatMap(d => list(d.sessions).map(s => ({
    id: text(s.id), title: text(s.title) || text(s.id), directory: text(d.directory),
    updated: Number(record(s.time).updated) || 0, parentID: text(s.parentID) || undefined,
  }))).filter(s => !s.parentID).sort((a, b) => b.updated - a.updated);
}
export function messageFrom(raw: Row): Message | null {
  const contextRaw = raw;
  if (raw.info && typeof raw.info === 'object' && Array.isArray(raw.parts)) raw = { ...record(raw.info), parts: raw.parts };
  const type = text(raw.type) || text(raw.role);
  if (['system', 'idle', 'model-switched', 'agent-selected', 'agent-switched', 'location-switched'].includes(type)) return null;
  const ordinals = { text: 0, reasoning: 0 };
  const content = (Array.isArray(raw.parts) ? list(raw.parts) : list(raw.content)).map(part => {
    if (part.type !== 'text' && part.type !== 'reasoning') return part;
    return { ...part, ordinal: ordinals[part.type]++ };
  });
  const texts = content.filter(p => p.type === 'text').map(p => text(p.text));
  const model = record(raw.model), metadata = record(raw.metadata), metadataModel = record(metadata.model);
  const identity = Object.keys(model).length ? model : type === 'user' ? metadataModel : {};
  const time = record(raw.time), tokens = record(raw.tokens);
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return {
    contextRaw, contextOrigin: 'projection', contextContent: content,
    id: text(raw.id) || text(raw.messageID), role: ['user', 'peer', 'shell', 'synthetic'].includes(type) ? 'user' : type === 'compaction' ? 'compaction' : 'assistant',
    projectionInfo: {
      nativeType: text(raw.nativeType) || type, clientRole: raw.clientRole, sessionID: raw.sessionID, parentID: raw.parentID,
      mode: raw.mode, description: raw.description, error: raw.error, summary: raw.summary,
      ...(type === 'synthetic' ? { metadata: raw.metadata } : {}),
      ...(type === 'shell' ? { command: raw.command, output: raw.output, status: raw.status, exit: raw.exit } : {}),
    },
    text: text(raw.text) || texts.join('\n\n') || (type === 'synthetic' ? text(raw.description) : type === 'shell' ? [text(raw.command), text(record(raw.output).output)].filter(Boolean).join('\n') : ''),
    reasoning: content.filter(p => p.type === 'reasoning').map(p => text(p.text)).join('\n'),
    tools: content.filter(p => p.type === 'tool'),
    cards: type === 'compaction' ? [raw] : content.filter(p => p.type === 'card' || p.type === 'compaction'),
    files: [...content.filter(p => p.type === 'file'), ...list(raw.files)],
    content,
    ...(text(identity.id) || text(identity.modelID) || text(raw.modelID) ? { modelID: text(identity.id) || text(identity.modelID) || text(raw.modelID) } : {}),
    ...(text(identity.providerID) || text(raw.providerID) ? { providerID: text(identity.providerID) || text(raw.providerID) } : {}),
    ...(text(identity.name) || text(raw.modelName) ? { modelName: text(identity.name) || text(raw.modelName) } : {}),
    ...(text(identity.variant) || text(raw.variant) || (type === 'user' && text(metadata.variant)) ? { variant: text(identity.variant) || text(raw.variant) || text(metadata.variant) } : {}),
    ...(text(raw.agent) || (type === 'user' && text(metadata.agent)) ? { agent: text(raw.agent) || text(metadata.agent) } : {}),
    ...(text(raw.finish) || text(raw.rawFinish) ? { finish: text(raw.finish) || text(raw.rawFinish) } : {}),
    time: { ...(finite(time.created) ? { created: time.created } : {}), ...(finite(time.streamed) ? { streamed: time.streamed } : {}), ...(finite(time.completed) ? { completed: time.completed } : {}) },
    tokens: { ...(finite(tokens.output) ? { output: tokens.output } : {}), ...(finite(tokens.reasoning) ? { reasoning: tokens.reasoning } : {}) },
    ...(typeof raw.ordinal === 'number' ? { ordinal: raw.ordinal } : {}),
    error: text(record(raw.error).message) || (raw.status === 'error' ? texts.join('\n') : ''),
  };
}
export function messagesFrom(payload: unknown, contact: boolean, limit = contact ? 30 : 20): MessagePage {
  const body = record(payload);
  const rows = contact ? body.messages : body.data;
  if (!Array.isArray(rows)) throw new Error('Invalid message page');
  const messages = list(rows).map(messageFrom).filter((m): m is Message => !!m && !!m.id);
  if (!contact) messages.reverse();
  if (contact) messages.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cursor = contact ? text(body.nextCursor) || null : text(record(body.cursor).next) || text(body.cursor) || null;
  const complete = contact ? body.complete === true || !cursor : !cursor || rows.length < limit;
  return { messages, cursor: complete ? null : cursor, complete, generation: typeof body.generation === 'number' ? body.generation : undefined, revision: typeof body.revision === 'number' ? body.revision : undefined };
}
/** Failed/malformed authority is never an empty successful list. */
export function rowsFrom(payload: unknown): Row[] {
  const rows = unwrap(payload);
  if (!Array.isArray(rows)) throw new Error('Expected authoritative list');
  return list(rows);
}
export function inboxFrom(payload: unknown): Row[] {
  return rowsFrom(payload).filter(item => !item.type || item.type === 'user').map(item => {
    if (!text(item.id) || !text(item.sessionID)) throw new Error('Invalid inbox item');
    return { ...item, payload: { ...record(item.payload), text: text(record(item.payload).text) || text(item.text) } };
  });
}
export function activeFrom(payload: unknown, sessionID: string): boolean {
  const value = unwrap(payload);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => record(item).type !== 'running')) throw new Error('Invalid active membership');
  return Object.prototype.hasOwnProperty.call(value, sessionID);
}
/** Swift sends the SSE data string, not an already-decoded OpenCode event. */
export function runtimeEventFrom(payload: unknown): RuntimeEvent | null {
  const native = record(payload);
  if (native.key !== 'global' && native.key !== 'chat') return null;
  if (native.type === 'reconnected') return { key: native.key, type: 'reconnected', body: {}, directory: '' };
  if (typeof native.data !== 'string') return null;
  try {
    const envelope = record(JSON.parse(native.data));
    const event = envelope.payload ? record(envelope.payload) : envelope;
    const durable = record(event.durable);
    if (durable.kind === 'sync' || durable.type === 'sync' || durable.source === 'sync' || durable.sync === true || text(durable.aggregateID).startsWith('sync:')) return null;
    const body = event.data && typeof event.data === 'object' ? record(event.data) : event.properties ? record(event.properties) : event;
    if (!text(event.type)) return null;
    return { key: native.key, type: text(event.type).replace(/\.\d+$/, ''), body, directory: text(envelope.directory) || text(body.directory) || text(record(event.location).directory) || text(record(event.location).path), id: text(event.id) || undefined, created: typeof event.created === 'number' ? event.created : undefined };
  } catch { return null; }
}
export function eventSessionID(event: RuntimeEvent): string {
  return text(event.body.sessionID) || text(event.body.sessionId) || text(record(event.body.info).sessionID) || text(record(event.body.part).sessionID);
}
export function eventBusy(event: RuntimeEvent): boolean | undefined {
  if (event.type === 'session.execution.started' || event.type === 'session.step.started' || event.type === 'session.retry.scheduled') return true;
  if (event.type === 'session.execution.interrupted') return event.body.reason === 'shutdown';
  if (['session.execution.succeeded', 'session.execution.failed', 'session.idle', 'session.error'].includes(event.type)) return false;
  if (event.type === 'session.status' || event.type === 'yuri:session-status') {
    const status = text(record(event.body.status).type) || text(event.body.status) || text(record(event.body.info).type);
    if (['busy', 'running', 'retry'].includes(status)) return true;
    if (status === 'idle') return false;
  }
  if (event.type === 'yuri:contact-turn-start') return true;
  if (event.type === 'yuri:contact-turn-end') return false;
  return undefined;
}
export const isSessionContentEvent = (event: RuntimeEvent): boolean => /^session\.(text|reasoning|tool|step)\./.test(event.type);
/** Native content ordinals are per kind; array order, never IDs, owns display order. */
export function applySessionContent(previous: Message | undefined, event: RuntimeEvent): Message | undefined {
  const body = event.body, messageID = text(body.assistantMessageID);
  if (!messageID || !isSessionContentEvent(event)) return previous;
  const message: Message = previous ?? { id: messageID, role: 'assistant', text: '', reasoning: '', tools: [], cards: [], files: [], error: '', content: [], contextRaw: { id: messageID, type: 'assistant' }, contextOrigin: 'stream' };
  if (event.type.startsWith('session.step.')) {
    if (event.type === 'session.step.failed') {
      const error = text(record(body.error).message) || text(body.error);
      return error === message.error ? message : { ...message, error, contextLive: true };
    }
    return message;
  }
  const parts = message.content ?? [
    ...(message.text ? [{ type: 'text', ordinal: 0, text: message.text }] : []),
    ...(message.reasoning ? [{ type: 'reasoning', ordinal: 0, text: message.reasoning }] : []),
    ...message.tools,
  ];
  let index: number, next: Row;
  const kind = event.type.startsWith('session.text.') ? 'text' : event.type.startsWith('session.reasoning.') ? 'reasoning' : 'tool';
  if (kind !== 'tool') {
    const ordinal = typeof body.ordinal === 'number' ? body.ordinal : 0;
    index = parts.findIndex(part => part.type === kind && part.ordinal === ordinal);
    const part = parts[index] ?? { type: kind, ordinal, text: '' };
    // Repeated starts do not erase materialized or already streamed content.
    if (event.type.endsWith('.started') && index >= 0) return message;
    const value = event.type.endsWith('.delta') ? text(part.text) + text(body.delta) : event.type.endsWith('.ended') ? text(body.text) : text(part.text);
    if (index >= 0 && value === part.text) return message;
    next = { ...part, text: value };
  } else {
    const toolID = text(body.id);
    if (!toolID) return previous;
    index = parts.findIndex(part => part.type === 'tool' && part.id === toolID);
    const part = parts[index] ?? { type: 'tool', id: toolID, name: text(body.name), state: { status: 'pending', input: '' } };
    const state = record(part.state), time = record(state.time);
    const clock = event.created;
    let patch: Row;
    switch (event.type) {
      case 'session.tool.input.started': if (index >= 0) return message; patch = {}; break;
      case 'session.tool.input.delta':
        if (!['pending', 'streaming'].includes(text(state.status))) return message;
        patch = { input: text(state.input) + text(body.delta) }; break;
      case 'session.tool.input.ended':
        if (!['pending', 'streaming'].includes(text(state.status))) return message;
        patch = { input: text(body.text) }; break;
      case 'session.tool.called':
        if (state.status === 'completed' || state.status === 'error') return message;
        patch = { status: 'running', input: body.input ?? state.input, ...(clock === undefined ? {} : { time: { ...time, start: clock } }) }; break;
      case 'session.tool.progress': patch = { metadata: record(body.metadata) }; break;
      case 'session.tool.success':
      case 'session.tool.failed':
        patch = { status: event.type.endsWith('.success') ? 'completed' : 'error', output: list(body.content).filter(item => item.type === 'text').map(item => text(item.text)).join('\n'), metadata: body.metadata ?? state.metadata, ...(event.type.endsWith('.failed') ? { error: text(record(body.error).message) || text(body.error) } : {}), ...(clock === undefined ? {} : { time: { ...time, end: clock } }) }; break;
      default: return previous;
    }
    next = { ...part, ...(text(body.name) ? { name: text(body.name) } : {}), state: { ...state, ...patch } };
    if (index >= 0 && JSON.stringify(next) === JSON.stringify(part)) return message;
  }
  const content = [...parts];
  if (index < 0) content.push(next); else content[index] = next;
  return {
    ...message, content, contextLive: true,
    text: kind === 'text' ? content.filter(part => part.type === 'text').map(part => text(part.text)).join('\n\n') : message.text,
    reasoning: kind === 'reasoning' ? content.filter(part => part.type === 'reasoning').map(part => text(part.text)).join('\n') : message.reasoning,
    tools: kind === 'tool' ? content.filter(part => part.type === 'tool') : message.tools,
  };
}
export function mergeMessages(previous: Message[], incoming: Message[], older = false): Message[] {
  const replacements = new Map(incoming.map(m => [m.id, m]));
  const known = new Set(previous.map(m => m.id));
  const added = incoming.filter(m => !known.has(m.id));
  const stable = previous.map(m => {
    const next = replacements.get(m.id);
    return next && JSON.stringify(next) !== JSON.stringify(m) ? next : m;
  });
  return older ? [...added, ...stable] : [...stable, ...added];
}
