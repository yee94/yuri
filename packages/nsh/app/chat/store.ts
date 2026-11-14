import { Storage, batch, signal, untracked, type Signal } from 'nsh';
import {
  currentScope,
  list,
  onHostRuntimeEvent,
  query,
  record,
  request,
  sessionPath,
  startChatStream,
  textOf,
  unwrap,
  type RuntimeEvent,
  type Row,
} from '../core/host';
import {
  hostAvailable,
  hostFor,
  remoteHostEventFrom,
  remotePath,
  remoteSubscribe,
  remoteUnsubscribe,
  refreshRemoteProjects,
} from '../core/remote';
import { refreshCatalog } from '../core/store';
import { openSession, type RemoteSessionTarget } from '../shell/nav';
import { scanContextTokenBaseline } from '../../../ui/src/sync/context-token-baseline';
import { resolveNativeForkBoundary } from '../../../ui/src/sync/session-fork-boundary';
import { acknowledgeAttachments, attachmentFiles, reconcileAttachments } from './attachments';
import { messageWithComposerQuotes, referenceFiles, referenceToken } from './references';
import {
  answersToFormAnswer,
  groupRows,
  messageDuration,
  messageFrom,
  messageTps,
  messagesFrom,
  partKey,
  questionFor as questionForm,
  userText,
  type ParsedMessage,
  type Role,
  type RowGroup,
} from './model';

export type PartEntry = { key: string; sig: Signal<Row> };

export type MessageEntry = {
  id: string;
  role: Role;
  info: Signal<Row>;
  parts: Signal<PartEntry[]>;
  attachments: Signal<Row[]>;
  sigs: Map<string, Signal<Row>>;
  text: () => string;
};

export type Selection = { providerID: string; modelID: string; variant?: string; agent?: string };

/** One confirmed `@file`, `/command` or quoted message chip above the input. */
export type DraftReference = { id: string; kind: 'file' | 'command' | 'quote'; value: string; label: string };

export type Conversation = {
  key: string;
  directory: Signal<string>;
  sessionID: Signal<string | null>;
  title: Signal<string>;
  /** The machine this session lives on; `null` for a local session. */
  remote: RemoteSessionTarget | null;
  hostId: string | null;
  messages: Signal<MessageEntry[]>;
  rows: Signal<RowGroup[]>;
  selection: Signal<Selection>;
  draft: Signal<string>;
  references: Signal<DraftReference[]>;
  /** A message the timeline asked the transcript to reveal. */
  focusMessage: Signal<string | null>;
  busy: Signal<boolean>;
  retry: Signal<Row | null>;
  loading: Signal<boolean>;
  older: Signal<boolean>;
  more: Signal<boolean>;
  error: Signal<string>;
  stream: Signal<'connecting' | 'live' | 'disconnected'>;
  permissions: Signal<Row[]>;
  forms: Signal<Row[]>;
  inbox: Signal<Row[]>;
  busyItem: Signal<string>;
  sending: Signal<boolean>;
  atLatest: Signal<boolean>;
  entries: Map<string, MessageEntry>;
  cursor: string | null;
  detach: (() => void) | null;
  owner: string;
  draftTimer: ReturnType<typeof setTimeout> | undefined;
  reading: boolean;
};

const conversations = new Map<string, Conversation>();
let ownerCounter = 0;
let activeOwner: { id: string; stop: () => void } | null = null;

export function conversationFor(input: {
  key: string;
  directory: string;
  sessionID: string | null;
  title?: string;
  remote?: RemoteSessionTarget | null;
}): Conversation {
  const existing = conversations.get(input.key);
  if (existing) return existing;
  const conversation: Conversation = {
    key: input.key,
    directory: signal(input.directory),
    sessionID: signal<string | null>(input.sessionID),
    title: signal(input.title ?? ''),
    remote: input.remote ?? null,
    hostId: input.remote?.hostId ?? null,
    messages: signal<MessageEntry[]>([]),
    rows: signal<RowGroup[]>([]),
    selection: signal<Selection>({ providerID: '', modelID: '' }),
    draft: signal(''),
    references: signal<DraftReference[]>([]),
    focusMessage: signal<string | null>(null),
    busy: signal(false),
    retry: signal<Row | null>(null),
    loading: signal(false),
    older: signal(false),
    more: signal(false),
    error: signal(''),
    stream: signal<'connecting' | 'live' | 'disconnected'>('connecting'),
    permissions: signal<Row[]>([]),
    forms: signal<Row[]>([]),
    inbox: signal<Row[]>([]),
    busyItem: signal(''),
    sending: signal(false),
    atLatest: signal(true),
    entries: new Map(),
    cursor: null,
    detach: null,
    owner: '',
    draftTimer: undefined,
    reading: false,
  };
  conversations.set(input.key, conversation);
  void readDraft(conversation);
  return conversation;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One session's request stays on its own machine: the local connection or the Host proxy. */
function scopedRequest<T = unknown>(
  hostId: string | null,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  return hostId ? request<T>(remotePath(hostId, path), method, body) : request<T>(path, method, body);
}

function ask<T = unknown>(conversation: Conversation, path: string, method = 'GET', body?: unknown): Promise<T> {
  return scopedRequest<T>(conversation.hostId, path, method, body);
}

/** A sheet or composer read for this session's own machine (local or Host proxy). */
export const sessionRequest = ask;

const sameDirectory = (left: string, right: string) =>
  (left || '').replace(/\\/g, '/').replace(/\/+$/, '') === (right || '').replace(/\\/g, '/').replace(/\/+$/, '');

function assertRemoteAvailable(conversation: Conversation): void {
  if (!conversation.hostId) return;
  // Web remote-session-state refuses to send through an unavailable Host.
  if (!hostAvailable(conversation.hostId)) {
    throw new Error(`Remote Host is ${hostFor(conversation.hostId)?.state ?? 'unavailable'}`);
  }
}

const same = (left: unknown, right: unknown) => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

function entryFor(conversation: Conversation, id: string, role: Role, info: Row = {}): MessageEntry {
  const existing = conversation.entries.get(id);
  if (existing) return existing;
  const entry: MessageEntry = {
    id,
    role,
    info: signal<Row>({ id, role, ...info }),
    parts: signal<PartEntry[]>([]),
    attachments: signal<Row[]>([]),
    sigs: new Map(),
    text: () => entry.parts().filter((part) => part.sig().type === 'text').map((part) => textOf(part.sig().text)).join('\n\n'),
  };
  conversation.entries.set(id, entry);
  return entry;
}

function reconcileParts(entry: MessageEntry, parsed: ParsedMessage): boolean {
  const previous = entry.parts();
  const next: PartEntry[] = [];
  let structural = false;
  const seen = new Set<string>();
  for (const part of parsed.parts) {
    seen.add(part.key);
    let sig = entry.sigs.get(part.key);
    if (!sig) {
      sig = signal<Row>(part.raw);
      entry.sigs.set(part.key, sig);
      structural = true;
    } else if (!same(sig(), part.raw)) sig.set(part.raw);
    next.push({ key: part.key, sig });
  }
  for (const [key] of entry.sigs) {
    if (!seen.has(key)) {
      entry.sigs.delete(key);
      structural = true;
    }
  }
  if (structural || previous.length !== next.length) entry.parts.set(next);
  if (!same(entry.info(), parsed.info)) entry.info.set(parsed.info);
  if (!same(entry.attachments(), parsed.attachments)) entry.attachments.set(parsed.attachments);
  return structural;
}

function adoptMessage(conversation: Conversation, parsed: ParsedMessage): MessageEntry {
  const entry = entryFor(conversation, parsed.id, parsed.role, parsed.info);
  entry.role = parsed.role;
  reconcileParts(entry, parsed);
  return entry;
}

function syncRows(conversation: Conversation) {
  const groups = groupRows(
    conversation.messages().map((entry) => ({ id: entry.id, role: entry.role })),
    conversation.busy(),
  );
  const previous = new Map(conversation.rows().map((row) => [row.key, row]));
  const total = groups.length;
  const next = groups.map((row, index) => {
    const last = index === total - 1;
    const previousRow = previous.get(row.key);
    if (
      previousRow &&
      previousRow.ids.length === row.ids.length &&
      previousRow.ids.every((id, at) => id === row.ids[at]) &&
      previousRow.last === last &&
      previousRow.live === row.live
    ) {
      return previousRow;
    }
    return { ...row, last };
  });
  const unchanged = next.length === conversation.rows().length && next.every((row, index) => row === conversation.rows()[index]);
  if (!unchanged) conversation.rows.set(next);
}

function appendMessage(conversation: Conversation, entry: MessageEntry) {
  const existing = conversation.messages();
  if (existing.some((row) => row.id === entry.id)) {
    syncRows(conversation);
    return;
  }
  conversation.messages.set([...existing, entry]);
  syncRows(conversation);
}

export function addUserMessage(conversation: Conversation, id: string, text: string, error = ''): MessageEntry {
  const entry = entryFor(conversation, id, 'user', {
    id,
    role: 'user',
    ...(error ? { error } : { optimistic: true }),
    time: { created: Date.now() },
  });
  entry.sigs.set(`${id}|text|0`, signal<Row>({ type: 'text', text, ordinal: 0 }));
  entry.parts.set([{ key: `${id}|text|0`, sig: entry.sigs.get(`${id}|text|0`)! }]);
  conversation.entries.set(id, entry);
  appendMessage(conversation, entry);
  return entry;
}

function mergePage(conversation: Conversation, page: { messages: ParsedMessage[]; cursor: string | null; complete: boolean }, older: boolean) {
  const existing = conversation.messages();
  const known = new Set(existing.map((entry) => entry.id));
  if (!older) {
    const ordered = page.messages.map((message) => adoptMessage(conversation, message));
    const ids = new Set(page.messages.map((message) => message.id));
    const retained = existing.filter(
      (entry) => !ids.has(entry.id) && (!!entry.info().streaming || !!entry.info().optimistic),
    );
    conversation.messages.set([...ordered, ...retained]);
  } else {
    const fresh = page.messages
      .filter((message) => !known.has(message.id))
      .map((message) => adoptMessage(conversation, message));
    if (fresh.length) conversation.messages.set([...fresh, ...existing]);
  }
  conversation.cursor = page.cursor;
  conversation.more.set(!page.complete);
  syncRows(conversation);
}

export async function loadMessages(conversation: Conversation, older = false): Promise<void> {
  const id = conversation.sessionID();
  if (!id || conversation.reading) return;
  if (older && (!conversation.cursor || !conversation.more() || conversation.older())) return;
  conversation.reading = true;
  if (older) conversation.older.set(true);
  else conversation.loading.set(conversation.messages().length === 0);
  try {
    const suffix = older
      ? `&limit=20&order=desc&cursor=${encodeURIComponent(conversation.cursor ?? '')}`
      : '&limit=20&order=desc';
    const payload = await ask(conversation, `${sessionPath(id, 'message')}?${query(conversation.directory())}${suffix}`);
    mergePage(conversation, messagesFrom(payload), older);
    conversation.error.set('');
  } catch (error) {
    if (!older) conversation.error.set(errorText(error));
  } finally {
    conversation.reading = false;
    conversation.loading.set(false);
    conversation.older.set(false);
  }
}

async function readSelection(conversation: Conversation, id: string) {
  try {
    const value = record(unwrap(await ask(conversation, `/api/session/${encodeURIComponent(id)}?${query(conversation.directory())}`)));
    const model = record(value.model);
    const providerID = textOf(model.providerID);
    const modelID = textOf(model.id) || textOf(model.modelID);
    const variant = textOf(model.variant);
    const agent = textOf(value.agent);
    const title = textOf(value.title);
    if (title && !conversation.title()) conversation.title.set(title);
    if (providerID && modelID) {
      conversation.selection.set({ providerID, modelID, ...(variant ? { variant } : {}), ...(agent ? { agent } : {}) });
    } else if (agent) {
      conversation.selection.set({ ...conversation.selection(), agent });
    }
  } catch {
    // The composer keeps its default selection until the session read succeeds.
  }
}

const permissionLocation = (directory: string) => `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;

export async function readBlocking(conversation: Conversation): Promise<void> {
  const id = conversation.sessionID();
  if (!id) return;
  const read = async (path: string): Promise<Row[]> => {
    try {
      const value = unwrap(await ask(conversation, path));
      return Array.isArray(value) ? list(value) : [];
    } catch {
      return [];
    }
  };
  const [permissions, forms] = await Promise.all([
    read(`/api/permission/request?${permissionLocation(conversation.directory())}`),
    read(`/api/form?${permissionLocation(conversation.directory())}`),
  ]);
  const own = (row: Row) => textOf(row.sessionID) === id || textOf(record(row.form).sessionID) === id;
  conversation.permissions.set(permissions.filter(own));
  conversation.forms.set(forms.filter(own));
}

export async function readInbox(conversation: Conversation): Promise<void> {
  const id = conversation.sessionID();
  if (!id) return;
  try {
    const value = unwrap(await ask(conversation, `${sessionPath(id, 'inbox')}?${query(conversation.directory())}`));
    conversation.inbox.set(Array.isArray(value) ? list(value) : []);
  } catch {
    // A failed inbox read keeps the previous queue.
  }
}

export async function replyPermission(conversation: Conversation, requestID: string, decision: 'once' | 'always' | 'reject'): Promise<void> {
  const id = conversation.sessionID();
  if (!id) return;
  conversation.permissions.set(conversation.permissions().filter((row) => textOf(row.id) !== requestID));
  try {
    await ask(conversation, `${sessionPath(id, `permission/${encodeURIComponent(requestID)}/reply`)}?${query(conversation.directory())}`, 'POST', { decision });
  } catch (error) {
    conversation.error.set(errorText(error));
  } finally {
    void readBlocking(conversation);
  }
}

export function questionFor(form: Row) {
  return questionForm(form);
}

export async function replyForm(conversation: Conversation, form: Row, answers: string[][]): Promise<void> {
  const id = conversation.sessionID();
  const formID = textOf(form.id);
  if (!id || !formID) return;
  conversation.forms.set(conversation.forms().filter((row) => textOf(row.id) !== formID));
  try {
    const fields = Array.isArray(form.fields) ? form.fields : [];
    const answer = fields.length ? answersToFormAnswer(answers, fields as never) : {};
    await ask(conversation, `${sessionPath(id, `form/${encodeURIComponent(formID)}/reply`)}?${query(conversation.directory())}`, 'POST', { answer });
  } catch (error) {
    conversation.error.set(errorText(error));
  } finally {
    void readBlocking(conversation);
  }
}

export async function cancelForm(conversation: Conversation, formID: string): Promise<void> {
  const id = conversation.sessionID();
  if (!id || !formID) return;
  conversation.forms.set(conversation.forms().filter((row) => textOf(row.id) !== formID));
  try {
    await ask(conversation, `${sessionPath(id, `form/${encodeURIComponent(formID)}/cancel`)}?${query(conversation.directory())}`, 'POST', {});
  } catch (error) {
    conversation.error.set(errorText(error));
  } finally {
    void readBlocking(conversation);
  }
}

export async function steerInbox(conversation: Conversation, inboxID: string): Promise<void> {
  const id = conversation.sessionID();
  if (!id || conversation.busyItem()) return;
  conversation.busyItem.set(inboxID);
  try {
    const row = conversation.inbox().find((entry) => textOf(entry.id) === inboxID);
    await ask(conversation, `${sessionPath(id, `inbox/${encodeURIComponent(inboxID)}`)}?${query(conversation.directory())}`, 'PATCH', { delivery: 'steer' });
    conversation.inbox.set(conversation.inbox().filter((entry) => textOf(entry.id) !== inboxID));
    const text = textOf(record(row?.payload).text) || textOf(row?.text);
    if (row && text) addUserMessage(conversation, inboxID, text);
  } catch (error) {
    conversation.error.set(errorText(error));
  } finally {
    conversation.busyItem.set('');
  }
}

export async function cancelInbox(conversation: Conversation, inboxID: string): Promise<void> {
  const id = conversation.sessionID();
  if (!id || conversation.busyItem()) return;
  conversation.busyItem.set(inboxID);
  try {
    await ask(conversation, `${sessionPath(id, `inbox/${encodeURIComponent(inboxID)}`)}?${query(conversation.directory())}`, 'DELETE');
    conversation.inbox.set(conversation.inbox().filter((row) => textOf(row.id) !== inboxID));
  } catch (error) {
    conversation.error.set(errorText(error));
  } finally {
    conversation.busyItem.set('');
  }
}

const submissionID = () => `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

async function createSession(conversation: Conversation): Promise<string> {
  const value = record(unwrap(await ask(conversation, '/api/session', 'POST', { location: { directory: conversation.directory() } })));
  const id = textOf(value.id);
  if (!id) throw new Error('Server returned no session ID');
  const title = textOf(value.title);
  if (title) conversation.title.set(title);
  return id;
}

export async function applySelection(conversation: Conversation, id: string): Promise<void> {
  const selection = conversation.selection();
  const calls: Promise<unknown>[] = [];
  if (selection.modelID && selection.providerID) {
    calls.push(
      ask(conversation, `${sessionPath(id, 'model')}?${query(conversation.directory())}`, 'POST', {
        model: { providerID: selection.providerID, id: selection.modelID, ...(selection.variant ? { variant: selection.variant } : {}) },
      }),
    );
  }
  if (selection.agent) calls.push(ask(conversation, `${sessionPath(id, 'agent')}?${query(conversation.directory())}`, 'POST', { agent: selection.agent }));
  await Promise.all(calls.map((call) => call.catch(() => undefined)));
}

export async function send(conversation: Conversation): Promise<boolean> {
  const raw = conversation.draft().trim();
  const references = conversation.references();
  const command = references.find((reference) => reference.kind === 'command');
  const quoted = references.filter((reference) => reference.kind === 'quote').map((reference) => reference.value);
  const files = [...attachmentFiles(conversation), ...referenceFiles(references, conversation.directory())];
  const text = messageWithComposerQuotes(quoted, raw);
  if ((!text && files.length === 0) || conversation.sending()) return false;
  conversation.sending.set(true);
  conversation.error.set('');
  const optimisticID = submissionID();
  let queued = false;
  try {
    assertRemoteAvailable(conversation);
    let id = conversation.sessionID();
    if (!id) {
      id = await createSession(conversation);
      conversation.sessionID.set(id);
      rekey(conversation, id);
      await applySelection(conversation, id);
    }
    queued = conversation.busy();
    if (!queued) addUserMessage(conversation, optimisticID, text);
    conversation.draft.set('');
    conversation.references.set([]);
    void saveDraft(conversation);
    const delivery = queued ? 'queue' : 'steer';
    if (command) {
      const args = text.replace(`/${command.value}`, '').trim();
      await ask(conversation, `${sessionPath(id, 'command')}?${query(conversation.directory())}`, 'POST', {
        name: command.value,
        text: args,
        delivery,
        ...(files.length ? { files } : {}),
      });
    } else {
      await ask(conversation, `${sessionPath(id, 'prompt')}?${query(conversation.directory())}`, 'POST', {
        id: optimisticID,
        text,
        delivery,
        ...(files.length ? { files } : {}),
      });
    }
    void acknowledgeAttachments(conversation);
    if (!queued) conversation.busy.set(true);
    conversation.atLatest.set(true);
    if (queued) void readInbox(conversation);
    if (conversation.hostId) void refreshRemoteProjects();
    else void refreshCatalog();
    return true;
  } catch (error) {
    const entry = conversation.entries.get(optimisticID);
    if (entry) entry.info.set({ ...entry.info(), error: errorText(error) });
    else conversation.draft.set(raw);
    conversation.error.set(errorText(error));
    return false;
  } finally {
    conversation.sending.set(false);
  }
}

function rekey(conversation: Conversation, id: string) {
  const next = conversation.hostId ? `remote:${conversation.hostId}:session:${id}` : `session:${id}`;
  if (conversation.key === next) return;
  const previous = conversation.key;
  conversations.delete(previous);
  conversation.key = next;
  conversations.set(next, conversation);
  void Storage.removeItem(`nsh.chat.draft.${previous}`).catch(() => undefined);
}

export async function retrySend(conversation: Conversation): Promise<void> {
  let failed: MessageEntry | undefined;
  const rows = conversation.messages();
  for (let index = rows.length - 1; index >= 0; index--) {
    const entry = rows[index]!;
    if (entry.role === 'user' && !!entry.info().error) {
      failed = entry;
      break;
    }
  }
  if (!failed) return;
  const text = failed.text();
  conversation.sending.set(true);
  try {
    const id = conversation.sessionID();
    if (!id) return;
    const next = submissionID();
    conversation.messages.set(conversation.messages().filter((row) => row.id !== failed!.id));
    conversation.entries.delete(failed.id);
    addUserMessage(conversation, next, text);
    await ask(conversation, `${sessionPath(id, 'prompt')}?${query(conversation.directory())}`, 'POST', {
      id: next,
      text,
      delivery: conversation.busy() ? 'queue' : 'steer',
    });
    conversation.error.set('');
    if (!conversation.busy()) conversation.busy.set(true);
  } catch (error) {
    conversation.error.set(errorText(error));
  } finally {
    conversation.sending.set(false);
  }
}

/** Resends one failed prompt and drops the failed bubble it replaces. */
export async function retryMessage(conversation: Conversation, entry: MessageEntry): Promise<void> {
  const id = conversation.sessionID();
  const text = entry.text();
  if (!id || !text || conversation.sending()) return;
  conversation.sending.set(true);
  try {
    const next = submissionID();
    const items = attachmentFiles(conversation);
    conversation.messages.set(conversation.messages().filter((row) => row.id !== entry.id));
    conversation.entries.delete(entry.id);
    const replacement = addUserMessage(conversation, next, text);
    void replacement;
    await ask(conversation, `${sessionPath(id, 'prompt')}?${query(conversation.directory())}`, 'POST', {
      id: next,
      text,
      delivery: conversation.busy() ? 'queue' : 'steer',
      ...(items.length ? { files: items } : {}),
    });
    conversation.error.set('');
    if (!conversation.busy()) conversation.busy.set(true);
  } catch (error) {
    conversation.error.set(errorText(error));
  } finally {
    conversation.sending.set(false);
  }
}

export async function stop(conversation: Conversation): Promise<void> {
  const id = conversation.sessionID();
  if (!id) return;
  try {
    await ask(conversation, `${sessionPath(id, 'interrupt')}?${query(conversation.directory())}`, 'POST', {});
    conversation.busy.set(false);
    conversation.retry.set(null);
    void loadMessages(conversation);
  } catch (error) {
    conversation.error.set(errorText(error));
  }
}

/* References: confirmed `@file` / `/command` tokens and quoted messages. */

export function addReference(
  conversation: Conversation,
  input: { kind: DraftReference['kind']; value: string; label?: string },
): void {
  const value = input.value.trim();
  if (!value) return;
  const current = conversation.references();
  const id = `${input.kind}:${value}`;
  const reference: DraftReference = { id, kind: input.kind, value, label: input.label ?? value };
  const next =
    input.kind === 'command'
      ? [...current.filter((entry) => entry.kind !== 'command'), reference]
      : current.some((entry) => entry.id === id)
        ? current
        : [...current, reference];
  conversation.references.set(next);
  void saveDraft(conversation);
}

export function removeReference(conversation: Conversation, id: string): void {
  const reference = conversation.references().find((entry) => entry.id === id);
  if (!reference) return;
  conversation.references.set(conversation.references().filter((entry) => entry.id !== id));
  const token = referenceToken(reference);
  const text = conversation.draft();
  if (token && text.includes(token)) {
    const at = text.indexOf(token);
    setDraft(conversation, `${text.slice(0, at)}${text.slice(at + token.length)}`.replace(/ {2,}/g, ' ').trimStart());
  }
  void saveDraft(conversation);
}

/** A chip whose token the user deleted no longer refers to anything. */
function pruneReferences(conversation: Conversation) {
  const text = conversation.draft();
  const kept = conversation.references().filter((reference) => {
    const token = referenceToken(reference);
    return !token || text.includes(token);
  });
  if (kept.length !== conversation.references().length) conversation.references.set(kept);
}

export async function revertToMessage(conversation: Conversation, messageID: string): Promise<void> {
  const id = conversation.sessionID();
  if (!id) return;
  if (conversation.busy()) throw new Error('busy');
  await ask(conversation, `${sessionPath(id, 'revert/stage')}?${query(conversation.directory())}`, 'POST', { messageID, files: true });
  await loadMessages(conversation);
}

/** Fork rows oldest-first; only the fetched window is read, never invented. */
async function forkRows(conversation: Conversation, id: string): Promise<{ id: string; type: string; status?: string }[]> {
  const rows: { id: string; type: string; status?: string }[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page += 1) {
    const payload = record(
      await ask(
        conversation,
        `${sessionPath(id, 'message')}?${query(conversation.directory())}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=desc'}`,
      ),
    );
    if (!Array.isArray(payload.data)) throw new Error('Invalid fork history');
    for (const entry of [...list(payload.data)].reverse()) {
      rows.push({
        id: textOf(entry.id),
        type: textOf(entry.type),
        ...(textOf(entry.status) ? { status: textOf(entry.status) } : {}),
      });
    }
    const next = textOf(record(payload.cursor).next);
    if (!next || list(payload.data).length < 100) break;
    cursor = next;
  }
  return rows;
}

/** `before` comes from the shared fork boundary so the selected turn is included. */
export async function forkFromMessage(conversation: Conversation, messageID: string): Promise<void> {
  const id = conversation.sessionID();
  if (!id) return;
  const before = resolveNativeForkBoundary(await forkRows(conversation, id), messageID, conversation.busy());
  const value = record(
    unwrap(await ask(conversation, `${sessionPath(id, 'fork')}?${query(conversation.directory())}`, 'POST', before ? { before } : {})),
  );
  const forked = textOf(value.id);
  if (!forked) throw new Error('Invalid fork acknowledgement');
  const directory = textOf(record(value.location).directory) || textOf(value.directory) || conversation.directory();
  openSession({
    id: forked,
    title: textOf(value.title) || conversation.title(),
    directory,
    ...(conversation.remote ? { remote: conversation.remote } : {}),
  });
}

export async function compactSession(conversation: Conversation): Promise<void> {
  const id = conversation.sessionID();
  if (!id || conversation.busy()) return;
  const submission = submissionID();
  await ask(conversation, `${sessionPath(id, 'compact')}?${query(conversation.directory())}`, 'POST', { id: submission, delivery: 'steer' });
  conversation.busy.set(true);
}

/** Child (subagent/task) sessions of this session, newest first. */
export async function loadChildSessions(directory: string, sessionID: string, hostId: string | null = null): Promise<Row[]> {
  const payload = record(
    await scopedRequest(
      hostId,
      `/api/session?${query(directory)}&parentID=${encodeURIComponent(sessionID)}&limit=50`,
    ),
  );
  if (!Array.isArray(payload.data)) throw new Error('Invalid child session list');
  return list(payload.data);
}

/** Web `scanContextTokenBaseline`: a compaction row makes the window unknown. */
export function contextUsage(conversation: Conversation): { tokens: number | null; pending: boolean } {
  const entries = conversation.messages();
  const baseline = scanContextTokenBaseline(
    entries.map((entry) => ({
      id: entry.id,
      role: entry.role,
      ...(textOf(entry.info().clientRole) ? { clientRole: textOf(entry.info().clientRole) } : {}),
      ...(textOf(entry.info().status) ? { status: textOf(entry.info().status) } : {}),
      tokens: record(entry.info().tokens),
    })),
    (id) => conversation.entries.get(id)?.parts().map((part) => part.sig()),
  );
  if (!baseline) return { tokens: null, pending: false };
  if ('compacted' in baseline) return { tokens: null, pending: true };
  return { tokens: baseline.totalTokens, pending: false };
}

function streamPart(entry: MessageEntry, key: string, initial: Row): Signal<Row> {
  const existing = entry.sigs.get(key);
  if (existing) return existing;
  const sig = signal<Row>(initial);
  entry.sigs.set(key, sig);
  entry.parts.set([...entry.parts(), { key, sig }]);
  return sig;
}

function textPart(entry: MessageEntry, kind: 'text' | 'reasoning', ordinal: number): Signal<Row> {
  const key = `${entry.id}|${kind}|${ordinal}`;
  return streamPart(entry, key, { type: kind, ordinal, text: '' });
}

function applyContentEvent(conversation: Conversation, event: RuntimeEvent): boolean {
  const body = event.body;
  const messageID = textOf(body.assistantMessageID) || textOf(record(body.part).messageID);
  if (!messageID) return false;
  const existing = conversation.entries.get(messageID);
  const entry = existing ?? entryFor(conversation, messageID, 'assistant', { id: messageID, role: 'assistant', streaming: true });
  if (!existing) {
    entry.info.set({ ...entry.info(), streaming: true, ...(textOf(body.sessionID) ? { sessionID: textOf(body.sessionID) } : {}) });
    appendMessage(conversation, entry);
  }
  const type = event.type;
  if (type === 'session.step.failed') {
    const error = textOf(record(body.error).message) || textOf(body.error);
    if (error && entry.info().error !== error) entry.info.set({ ...entry.info(), error });
    return false;
  }
  if (type.startsWith('session.step.')) return false;
  const ordinal = typeof body.ordinal === 'number' ? body.ordinal : 0;
  if (type.startsWith('session.text.') || type.startsWith('session.reasoning.')) {
    const kind = type.startsWith('session.text.') ? 'text' : 'reasoning';
    const sig = textPart(entry, kind, ordinal);
    const part = sig();
    if (type.endsWith('.started')) return false;
    const next = type.endsWith('.delta') ? textOf(part.text) + textOf(body.delta) : textOf(body.text);
    if (next !== textOf(part.text)) sig.set({ ...part, text: next });
    return false;
  }
  if (type.startsWith('session.tool.')) {
    const toolID = textOf(body.id);
    if (!toolID) return false;
    const key = `${messageID}|tool|${toolID}`;
    const known = entry.sigs.has(key);
    const sig = streamPart(entry, key, { type: 'tool', id: toolID, name: textOf(body.name), state: { status: 'pending', input: '' } });
    const part = sig();
    const state = record(part.state);
    const patch: Row = {};
    if (type === 'session.tool.input.started') {
      if (known) return false;
    } else if (type === 'session.tool.input.delta') {
      if (!['pending', 'streaming'].includes(textOf(state.status))) return false;
      patch.input = textOf(state.input) + textOf(body.delta);
    } else if (type === 'session.tool.input.ended') {
      if (!['pending', 'streaming'].includes(textOf(state.status))) return false;
      patch.input = textOf(body.text);
    } else if (type === 'session.tool.called') {
      if (textOf(state.status) === 'completed' || textOf(state.status) === 'error') return false;
      patch.status = 'running';
      patch.input = body.input ?? state.input;
    } else if (type === 'session.tool.progress') {
      patch.metadata = record(body.metadata);
    } else if (type === 'session.tool.success' || type === 'session.tool.failed') {
      patch.status = type.endsWith('.success') ? 'completed' : 'error';
      patch.output = list(body.content)
        .filter((item) => textOf(item.type) === 'text')
        .map((item) => textOf(item.text))
        .join('\n');
      if (body.metadata !== undefined) patch.metadata = body.metadata;
      if (type.endsWith('.failed')) patch.error = textOf(record(body.error).message) || textOf(body.error);
    } else return false;
    sig.set({ ...part, ...(textOf(body.name) ? { name: textOf(body.name) } : {}), state: { ...state, ...patch } });
    return !known;
  }
  return false;
}

function eventSession(event: RuntimeEvent): string {
  return (
    textOf(event.body.sessionID) ||
    textOf(event.body.sessionId) ||
    textOf(record(event.body.info).sessionID) ||
    textOf(record(event.body.part).sessionID)
  );
}

function eventStatus(event: RuntimeEvent): 'busy' | 'retry' | 'idle' | undefined {
  if (event.type === 'session.execution.started' || event.type === 'session.step.started') return 'busy';
  if (event.type === 'session.retry.scheduled') return 'retry';
  if (
    event.type === 'session.execution.interrupted' ||
    event.type === 'session.execution.succeeded' ||
    event.type === 'session.execution.failed' ||
    event.type === 'session.idle' ||
    event.type === 'session.error'
  )
    return 'idle';
  if (event.type === 'session.status' || event.type === 'yuri:session-status') {
    const status = textOf(record(event.body.status).type) || textOf(event.body.status) || textOf(record(event.body.info).type);
    if (status === 'busy' || status === 'running') return 'busy';
    if (status === 'retry') return 'retry';
    if (status === 'idle') return 'idle';
  }
  return undefined;
}

const blockingEvents = new Set([
  'form.created',
  'form.replied',
  'form.cancelled',
  'question.asked',
  'question.replied',
  'question.rejected',
  'permission.asked',
  'permission.replied',
]);

function handleEvent(conversation: Conversation, event: RuntimeEvent) {
  if (event.type === 'reconnected' || event.type === 'server.connected') {
    conversation.stream.set('live');
    void loadMessages(conversation);
    void readBlocking(conversation);
    void readInbox(conversation);
    return;
  }
  const id = conversation.sessionID();
  const target = eventSession(event);
  if (target && id && target !== id) return;
  if (event.directory && conversation.directory() && event.directory !== conversation.directory()) return;
  if (event.type.startsWith('session.text.') || event.type.startsWith('session.reasoning.') || event.type.startsWith('session.tool.') || event.type.startsWith('session.step.')) {
    batch(() => applyContentEvent(conversation, event));
    return;
  }
  const status = eventStatus(event);
  if (status !== undefined) {
    batch(() => {
      conversation.busy.set(status !== 'idle');
      if (status === 'retry') conversation.retry.set(event.body);
      else conversation.retry.set(null);
      if (status === 'idle') {
        for (const entry of conversation.messages()) {
          if (entry.info().streaming) entry.info.set({ ...entry.info(), streaming: false });
        }
        syncRows(conversation);
      }
    });
    if (status === 'idle') {
      void loadMessages(conversation);
      void readBlocking(conversation);
      void readInbox(conversation);
    }
    if (status === 'busy') void readInbox(conversation);
    return;
  }
  if (blockingEvents.has(event.type)) {
    void readBlocking(conversation);
    return;
  }
  if (event.type === 'session.inbox.delivered' || event.type === 'session.inbox.cancelled') {
    void readInbox(conversation);
    return;
  }
  if (event.type.startsWith('session.compaction.') || event.type === 'session.metadata.updated' || event.type === 'session.usage.updated') {
    void loadMessages(conversation);
  }
}

/**
 * Remote: the visible pane holds a Host content lease (Web `HostContentDemand`),
 * and the Hub forwards that machine's `/api/event` frames as `yuri:host-event`
 * on the global channel. Filters, refreshes and teardown match Web
 * `sync/remote-session-state.ts`.
 */
function attachRemoteSession(conversation: Conversation, id: string): () => void {
  const hostId = conversation.hostId!;
  const directory = conversation.directory();
  ownerCounter += 1;
  const owner = `nsh-chat-${Date.now().toString(36)}-${ownerCounter}`;
  conversation.owner = owner;
  conversation.stream.set('connecting');
  let lease = '';
  let generation = '';
  let released = false;

  const refresh = () => {
    if (released) return;
    void loadMessages(conversation);
    void readSelection(conversation, id);
    void readBlocking(conversation);
    void readInbox(conversation);
  };

  const acquire = async () => {
    const next = await remoteSubscribe(hostId, directory, id);
    if (released) {
      await remoteUnsubscribe(hostId, next).catch(() => undefined);
      return;
    }
    lease = next;
    conversation.stream.set('live');
  };

  const off = onHostRuntimeEvent((raw) => {
    if (released) return;
    const envelope = record(raw);
    if (envelope.key === 'global' && (envelope.type === 'reconnected' || envelope.type === 'server.connected')) {
      if (!lease) void acquire().catch(() => conversation.stream.set('disconnected'));
      refresh();
      return;
    }
    const event = remoteHostEventFrom(raw);
    if (!event || event.hostId !== hostId) return;
    if (event.directory && !sameDirectory(event.directory, directory)) return;
    if (event.type === 'yuri:content-ready') {
      const sessionID = textOf(event.body.sessionId);
      if (sessionID && sessionID !== id) return;
      const next = textOf(event.body.readyGeneration);
      if (next && next === generation) return;
      generation = next || generation;
      conversation.stream.set('live');
      refresh();
      return;
    }
    conversation.stream.set('live');
    handleEvent(conversation, { key: 'chat', type: event.type, body: event.body, directory: event.directory });
  });

  if (!hostAvailable(hostId)) conversation.stream.set('disconnected');
  else void acquire().catch(() => conversation.stream.set('disconnected'));
  refresh();
  void reconcileAttachments(conversation);
  const timer = setInterval(() => {
    if (released || conversation.owner !== owner) return;
    void readBlocking(conversation);
    if (conversation.stream() !== 'live') {
      if (!lease) void acquire().catch(() => undefined);
      void loadMessages(conversation);
      void readInbox(conversation);
    }
  }, 6000);
  const stop = () => {
    released = true;
    clearInterval(timer);
    off();
    if (lease) void remoteUnsubscribe(hostId, lease).catch(() => undefined);
    lease = '';
    conversation.stream.set('connecting');
    if (activeOwner?.id === owner) activeOwner = null;
  };
  // One visible transcript owns the Host lease, as one chat stream does locally
  // (the Hub caps Host content subscriptions).
  activeOwner?.stop();
  activeOwner = { id: owner, stop };
  return stop;
}

/** Subscribes one session's live stream; returns the teardown. */
export function attachSession(conversation: Conversation, id: string): () => void {
  if (conversation.hostId) return attachRemoteSession(conversation, id);
  ownerCounter += 1;
  const owner = `nsh-chat-${Date.now().toString(36)}-${ownerCounter}`;
  conversation.owner = owner;
  conversation.stream.set('connecting');
  const stop = startChatStream({
    directory: conversation.directory(),
    ownerID: owner,
    onEvent: (event) => handleEvent(conversation, event),
    onStatus: (status) => conversation.stream.set(status === 'live' ? 'live' : 'disconnected'),
  });
  activeOwner?.stop();
  activeOwner = { id: owner, stop };
  void loadMessages(conversation);
  void readSelection(conversation, id);
  void readBlocking(conversation);
  void readInbox(conversation);
  void reconcileAttachments(conversation);
  const timer = setInterval(() => {
    if (conversation.owner !== owner) return;
    void readBlocking(conversation);
    if (conversation.stream() !== 'live') {
      void loadMessages(conversation);
      void readInbox(conversation);
    }
  }, 6000);
  return () => {
    clearInterval(timer);
    stop();
    if (activeOwner?.id === owner) activeOwner = null;
    conversation.stream.set('connecting');
  };
}

/* Drafts and new-session selection. */

const draftKey = (conversation: Conversation) => `nsh.chat.draft.${conversation.key}`;

async function readDraft(conversation: Conversation) {
  try {
    const raw = await Storage.getItem(draftKey(conversation));
    if (!raw) return;
    const value = record(JSON.parse(raw));
    const text = textOf(value.text);
    if (text && !conversation.draft()) conversation.draft.set(text);
    if (Array.isArray(value.references) && !conversation.references().length) {
      const references = list(value.references).flatMap((entry): DraftReference[] => {
        const kind = textOf(entry.kind);
        const referenceValue = textOf(entry.value);
        if (!referenceValue || (kind !== 'file' && kind !== 'command' && kind !== 'quote')) return [];
        return [{ id: textOf(entry.id) || `${kind}:${referenceValue}`, kind, value: referenceValue, label: textOf(entry.label) || referenceValue }];
      });
      if (references.length) conversation.references.set(references);
    }
    const selection = record(value.selection);
    if (textOf(selection.modelID)) {
      conversation.selection.set({
        providerID: textOf(selection.providerID),
        modelID: textOf(selection.modelID),
        ...(textOf(selection.variant) ? { variant: textOf(selection.variant) } : {}),
        ...(textOf(selection.agent) ? { agent: textOf(selection.agent) } : {}),
      });
    }
  } catch {
    // A failed draft read leaves the composer empty.
  }
}

export async function saveDraft(conversation: Conversation): Promise<void> {
  if (conversation.draftTimer !== undefined) {
    clearTimeout(conversation.draftTimer);
    conversation.draftTimer = undefined;
  }
  const value = JSON.stringify({
    text: conversation.draft(),
    selection: conversation.selection(),
    references: conversation.references(),
  });
  try {
    if (!conversation.draft() && !conversation.selection().modelID) await Storage.removeItem(draftKey(conversation));
    else await Storage.setItem(draftKey(conversation), value);
  } catch {
    // Draft persistence is best effort.
  }
}

export function setDraft(conversation: Conversation, value: string) {
  if (conversation.draft() === value) return;
  conversation.draft.set(value);
  pruneReferences(conversation);
  if (conversation.draftTimer !== undefined) clearTimeout(conversation.draftTimer);
  conversation.draftTimer = setTimeout(() => {
    conversation.draftTimer = undefined;
    void saveDraft(conversation);
  }, 500);
}

/** A draft page picks another workspace: its key follows until it becomes a session. */
export async function moveDraft(conversation: Conversation, directory: string): Promise<void> {
  if (conversation.sessionID()) return;
  const previous = conversation.key;
  conversation.directory.set(directory);
  conversation.key = conversation.hostId ? `remote:${conversation.hostId}:draft:${directory}` : `draft:${directory}`;
  if (previous !== conversation.key) {
    conversations.delete(previous);
    conversations.set(conversation.key, conversation);
    await Storage.removeItem(`nsh.chat.draft.${previous}`).catch(() => undefined);
  }
  await saveDraft(conversation);
}

/* Catalogs: providers, agents, commands, files, preferences. */

export type Catalog = {
  /** The machine whose providers, agents and commands these are. */
  hostId: string | null;
  providers: Signal<Row[]>;
  agents: Signal<Row[]>;
  preferences: Signal<Row>;
  commands: Signal<Row[]>;
  skills: Signal<Row[]>;
  loading: Signal<boolean>;
  error: Signal<string>;
  loaded: boolean;
};

const catalogs = new Map<string, Catalog>();

export function catalogFor(directory: string, hostId: string | null = null): Catalog {
  const key = `${hostId ?? 'local'}::${directory}`;
  const existing = catalogs.get(key);
  if (existing) return existing;
  const catalog: Catalog = {
    hostId,
    providers: signal<Row[]>([]),
    agents: signal<Row[]>([]),
    preferences: signal<Row>({}),
    commands: signal<Row[]>([]),
    skills: signal<Row[]>([]),
    loading: signal(false),
    error: signal(''),
    loaded: false,
  };
  catalogs.set(key, catalog);
  return catalog;
}

export async function loadCatalog(directory: string, hostId: string | null = null): Promise<Catalog> {
  const catalog = catalogFor(directory, hostId);
  if (catalog.loading()) return catalog;
  if (catalog.loaded && catalog.providers().length) return catalog;
  catalog.loading.set(true);
  const failures: string[] = [];
  const settle = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      failures.push(errorText(error));
    }
  };
  await Promise.all([
    settle(async () => {
      const body = record(await scopedRequest(hostId, `/api/config/catalog/providers?${query(directory)}`));
      if (!Array.isArray(body.providers)) throw new Error('Invalid model catalog');
      catalog.providers.set(list(body.providers));
    }),
    settle(async () => {
      const value = unwrap(await scopedRequest(hostId, `/api/agent?location%5Bdirectory%5D=${encodeURIComponent(directory)}`));
      if (!Array.isArray(value)) throw new Error('Invalid agent catalog');
      catalog.agents.set(
        list(value).filter((agent) => {
          const mode = textOf(agent.mode);
          return agent.hidden !== true && !!textOf(agent.name) && (mode === '' || mode === 'primary' || mode === 'all');
        }),
      );
    }),
    settle(async () => {
      const value = unwrap(await scopedRequest(hostId, '/api/config/settings'));
      catalog.preferences.set(record(value));
    }),
    settle(async () => {
      const value = unwrap(await scopedRequest(hostId, `/api/command?location%5Bdirectory%5D=${encodeURIComponent(directory)}`));
      catalog.commands.set(Array.isArray(value) ? list(value) : []);
    }),
    settle(async () => {
      const value = record(unwrap(await scopedRequest(hostId, `/api/config/skills?${query(directory)}`)));
      catalog.skills.set(list(value.skills));
    }),
  ]);
  catalog.loaded = failures.length === 0;
  catalog.error.set(failures[0] ?? '');
  catalog.loading.set(false);
  return catalog;
}

export function defaultSelection(catalog: Catalog): Selection {
  const preferences = catalog.preferences();
  const recents = list(preferences.recentModels);
  const first = recents.find((row) => textOf(row.providerID) && textOf(row.modelID));
  if (first) {
    return {
      providerID: textOf(first.providerID),
      modelID: textOf(first.modelID),
      ...(textOf(first.variant) ? { variant: textOf(first.variant) } : {}),
      ...(textOf(preferences.defaultAgent) ? { agent: textOf(preferences.defaultAgent) } : {}),
    };
  }
  const provider = catalog.providers().find((row) => Object.keys(record(row.models)).length > 0);
  const model = provider ? Object.values(record(provider.models)).map(record).find((row) => textOf(row.id)) : undefined;
  const agent = catalog.agents().find((row) => textOf(row.name) === 'build') ?? catalog.agents()[0];
  return {
    providerID: textOf(provider?.id),
    modelID: textOf(model?.id),
    ...(agent && textOf(agent.name) ? { agent: textOf(agent.name) } : {}),
  };
}

export async function searchFiles(directory: string, value: string, hostId: string | null = null): Promise<Row[]> {
  const payload = record(
    await scopedRequest(hostId, `/api/fs/find?${query(directory)}&query=${encodeURIComponent(value)}&limit=20&type=file`),
  );
  return list(payload.data);
}

export async function readGitBranch(directory: string, hostId: string | null = null): Promise<{ branch: string; isRepo: boolean }> {
  try {
    const value = record(await scopedRequest(hostId, `/api/git/status?${query(directory)}`));
    return { branch: textOf(value.current), isRepo: value.isGitRepository === true };
  } catch {
    return { branch: '', isRepo: false };
  }
}

/** Distinct changed files of the working tree, for the header menu badge. */
export async function readDirtyChanges(directory: string, hostId: string | null = null): Promise<number> {
  try {
    const value = record(await scopedRequest(hostId, `/api/git/status?${query(directory)}`));
    if (!Array.isArray(value.files)) return 0;
    return new Set(list(value.files).map((file) => textOf(file.path)).filter(Boolean)).size;
  } catch {
    return 0;
  }
}

/** Context tokens of the newest assistant record (Web's backward baseline scan). */
export function contextTokens(conversation: Conversation): number | null {
  const rows = conversation.messages();
  for (let index = rows.length - 1; index >= 0; index--) {
    const entry = rows[index]!;
    if (entry.role !== 'assistant') continue;
    const tokens = record(entry.info().tokens);
    const count =
      (Number(tokens.input) || 0) +
      (Number(tokens.output) || 0) +
      (Number(tokens.reasoning) || 0) +
      (Number(record(tokens.cache).read) || 0) +
      (Number(record(tokens.cache).write) || 0);
    if (count > 0) return count;
  }
  return null;
}

export type ModelRef = { providerID: string; modelID: string; variant?: string };
export type PickerModel = ModelRef & { provider: Row; model: Row };

export function modelRefs(value: unknown): ModelRef[] {
  return list(value)
    .filter((row) => textOf(row.providerID) && textOf(row.modelID))
    .map((row) => ({
      providerID: textOf(row.providerID),
      modelID: textOf(row.modelID),
      ...(textOf(row.variant) ? { variant: textOf(row.variant) } : {}),
    }));
}

export const sameModel = (left: ModelRef, right: ModelRef) =>
  left.providerID === right.providerID && left.modelID === right.modelID;

/** Every visible model of the catalog, providers in the user's order. */
export function modelEntries(catalog: Catalog): PickerModel[] {
  const preferences = catalog.preferences();
  const hidden = modelRefs(preferences.hiddenModels);
  const order = Array.isArray(preferences.providerOrder) ? preferences.providerOrder.map(textOf) : [];
  return [...catalog.providers()]
    .sort((left, right) => {
      const rank = (provider: Row) => {
        const index = order.indexOf(textOf(provider.id));
        return index < 0 ? order.length : index;
      };
      return rank(left) - rank(right);
    })
    .flatMap((provider) =>
      Object.values(record(provider.models))
        .map(record)
        .filter((model) => textOf(model.id) && model.hidden !== true)
        .filter((model) => !hidden.some((ref) => sameModel(ref, { providerID: textOf(provider.id), modelID: textOf(model.id) })))
        .map((model) => ({ provider, model, providerID: textOf(provider.id), modelID: textOf(model.id) })),
    );
}

export const variantsOf = (model: Row): string[] => Object.keys(record(model.variants)).filter(Boolean);

async function writePreferences(hostId: string | null, patch: Row): Promise<void> {
  await scopedRequest(hostId, '/api/config/settings', 'PUT', patch);
}

export async function chooseModel(conversation: Conversation, catalog: Catalog, ref: ModelRef): Promise<void> {
  conversation.selection.set({
    ...conversation.selection(),
    providerID: ref.providerID,
    modelID: ref.modelID,
    variant: ref.variant,
  });
  void saveDraft(conversation);
  const id = conversation.sessionID();
  if (id) {
    await ask(conversation, `${sessionPath(id, 'model')}?${query(conversation.directory())}`, 'POST', {
      model: { providerID: ref.providerID, id: ref.modelID, ...(ref.variant ? { variant: ref.variant } : {}) },
    });
  }
  const preferences = catalog.preferences();
  const recent = [ref, ...modelRefs(preferences.recentModels).filter((entry) => !sameModel(entry, ref))].slice(0, 5);
  catalog.preferences.set({ ...preferences, recentModels: recent });
  await writePreferences(catalog.hostId, { recentModels: recent }).catch(() => undefined);
}

export async function chooseAgent(conversation: Conversation, name: string): Promise<void> {
  conversation.selection.set({ ...conversation.selection(), agent: name });
  void saveDraft(conversation);
  const id = conversation.sessionID();
  if (id) await ask(conversation, `${sessionPath(id, 'agent')}?${query(conversation.directory())}`, 'POST', { agent: name });
}

export async function toggleFavoriteModel(catalog: Catalog, ref: ModelRef): Promise<void> {
  const preferences = catalog.preferences();
  const favorites = modelRefs(preferences.favoriteModels);
  const next = favorites.some((entry) => sameModel(entry, ref))
    ? favorites.filter((entry) => !sameModel(entry, ref))
    : [ref, ...favorites].slice(0, 64);
  catalog.preferences.set({ ...preferences, favoriteModels: next });
  await writePreferences(catalog.hostId, { favoriteModels: next }).catch(() => undefined);
}

export { messageDuration, messageTps, userText, partKey, messageFrom };

export type { ParsedMessage, RowGroup };

export const isConnected = () => !!currentScope();
