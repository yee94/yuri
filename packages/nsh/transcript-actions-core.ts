import { messageFrom, record, text, type Attachment, type ChatTarget, type Message, type Row } from './model';
import { query, type request, sessionPath } from './runtime';
import { resolveNativeForkBoundary } from '../ui/src/sync/session-fork-boundary';

export type NativeEditDraft = { target: ChatTarget; messageID: string; text: string; files: Attachment[] };
export type NativeRevert = { messageID: string; files?: Row[] };
export type NativeHistoryOutcome = { status: 'accepted' | 'rejected' | 'unknown'; reason?: string; error?: unknown; target?: ChatTarget };
export type NativeHistoryInvocation = { current: () => boolean };
export type NativeHistoryWrite = { kind: 'stage' | 'clear' | 'fork'; messageID: string | null };
export type TranscriptScope = {
  /** Include Host generation + target identity; all rows of a chat share this key. */
  key: string;
  current: () => boolean;
  busy: () => boolean;
  message: () => Message | undefined;
};
export type TranscriptActionOptions = {
  send: typeof request;
  target: ChatTarget;
  scope: TranscriptScope;
  onEditDraft?: (draft: NativeEditDraft) => void | Promise<void>;
  canEditDraft?: () => boolean;
  onPending?: (pending: boolean) => void;
  onUncertain?: () => void;
  onOpenChat?: (target: ChatTarget) => void;
  onRevert?: (revert: NativeRevert | null) => void;
  /** Refresh authority, never optimistically remove history on a failed request. */
  onChanged?: () => void | Promise<void>;
  /** Persist the intent before dispatch; a lost receipt is never automatically replayed. */
  onDispatch?: (write: NativeHistoryWrite) => Promise<void>;
  onReceipt?: (outcome: NativeHistoryOutcome) => void | Promise<void>;
};
const mutations = new Map<string, { unknown: boolean }>();

/** Only durable Host references can round-trip through the native composer. */
export function nativeEditFiles(files: Row[]): Attachment[] {
  return files.map(file => {
    const source = record(file.source);
    const uri = text(file.uri) || (source.type === 'uri' ? text(source.uri) : '');
    if (!uri || /^data:/i.test(uri)) throw new Error('此附件缺少可恢复的文件引用，不能安全编辑消息');
    return { uri, name: text(file.name) || text(file.filename), mime: text(file.mime) || 'application/octet-stream' };
  });
}

export function nativeRevertFrom(payload: unknown): NativeRevert {
  const root = record(payload), value = record(root.data ?? root);
  if (!text(value.messageID)) throw new Error('Invalid revert acknowledgement');
  if (value.files !== undefined && (!Array.isArray(value.files) || value.files.some(file => {
    const row = record(file);
    return !(text(row.file) || text(row.path)) || !['added', 'deleted', 'modified'].includes(text(row.status)) || typeof row.additions !== 'number' || typeof row.deletions !== 'number' || typeof row.patch !== 'string';
  }))) throw new Error('Invalid revert file diff');
  return { messageID: text(value.messageID), ...(Array.isArray(value.files) ? { files: value.files.map(record) } : {}) };
}

/** Native SDK gap: wire comes from session-revert-api and the installed official client. */
export function createTranscriptActions(options: TranscriptActionOptions) {
  const request = options.send;
  const target = { ...options.target }, scope = options.scope;
  const identity = `${target.kind}:${target.directory}:${target.id}`;
  const lock = `${scope.key}:${identity}`;
  const current = () => scope.current() && identity === `${options.target.kind}:${options.target.directory}:${options.target.id}`;
  function assertCurrent() {
    if (!current()) throw new Error('Transcript source changed');
    if (target.kind !== 'session' || !target.id || !target.directory) throw new Error('Session action unavailable');
  }
  const path = (suffix: string) => `${sessionPath(target.id, suffix)}?${query(target.directory)}`;
  async function selected() {
    assertCurrent();
    const message = scope.message();
    if (!message?.id) throw new Error('Selected message is unavailable');
    const response = record(await request(path(`message/${encodeURIComponent(message.id)}`)));
    assertCurrent();
    const value = record(response.data ?? response);
    if (value.id !== message.id || scope.message()?.id !== message.id) throw new Error('Selected message is unavailable');
    return { message, raw: value };
  }
  async function idle() {
    if (scope.busy()) throw new Error('Session is running');
    const response = await request('/api/session/active');
    const active = record(response).data ?? response;
    assertCurrent();
    if (!active || typeof active !== 'object' || Array.isArray(active) || Object.values(active).some(item => record(item).type !== 'running')) throw new Error('Invalid active membership');
    if (Object.hasOwn(active, target.id) || scope.busy()) throw new Error('Session is running');
  }
  async function mutation(work: (dispatch: <T>(write: NativeHistoryWrite, work: () => Promise<T>, parse: (value: T) => void) => Promise<void>) => Promise<void>, invocation?: NativeHistoryInvocation): Promise<NativeHistoryOutcome> {
    if (!current() || invocation?.current() === false) return { status: 'rejected', reason: 'stale' };
    if (mutations.has(lock)) return { status: 'rejected', reason: 'pending', error: new Error('Session history action is pending') };
    const owner = { unknown: false };
    mutations.set(lock, owner);
    let acquired = false;
    let dispatched = false, acknowledged = false;
    try {
      assertCurrent();
      options.onPending?.(true); acquired = true;
      await work(async (write, send, parse) => {
        assertCurrent();
        if (invocation?.current() === false) throw new Error('Transcript source changed');
        await options.onDispatch?.(write);
        assertCurrent();
        if (invocation?.current() === false) throw new Error('Transcript source changed');
        dispatched = true;
        const value = await send();
        parse(value);
        acknowledged = true;
        await options.onReceipt?.({ status: 'accepted' });
      });
      return { status: 'accepted' };
    } catch (failure) {
      const status = record(failure).status;
      const outcome: NativeHistoryOutcome = { status: acknowledged ? 'accepted' : !dispatched || typeof status === 'number' && status >= 400 && status < 500 && status !== 408 ? 'rejected' : 'unknown', error: failure };
      if (outcome.status === 'unknown') {
        owner.unknown = true;
        options.onUncertain?.();
        // Unknown write results must reload authority, never masquerade as rollback.
        try { await options.onChanged?.(); } catch { /* Keep the original failure and last valid indicator. */ }
      } else if (!acknowledged && acquired) {
        try { await options.onReceipt?.(outcome); } catch { /* A retained journal remains conservatively locked on restart. */ }
      }
      return outcome;
    } finally {
      if (!owner.unknown) { mutations.delete(lock); if (acquired) options.onPending?.(false); }
    }
  }
  const legacy = async (operation: Promise<NativeHistoryOutcome>) => {
    const result = await operation;
    if (result.error) throw result.error;
    if (result.status !== 'accepted') throw new Error(result.reason || 'Session action unavailable');
  };
  async function stageSelected(files: boolean, invocation?: NativeHistoryInvocation, edit = false) {
    return mutation(async dispatch => {
      if (edit && (!options.onEditDraft || options.canEditDraft?.() === false)) throw new Error('当前草稿尚未就绪或有待恢复操作，不能编辑历史消息');
      await idle();
      const { message, raw } = await selected();
      if (raw.type !== 'user' || message.role !== 'user') throw new Error('Revert requires a user message');
      let draft: NativeEditDraft | undefined;
      if (edit) {
        const authoritative = messageFrom(raw);
        if (!authoritative) throw new Error('Selected message is unavailable');
        if (authoritative.content?.some(part => !['text', 'file'].includes(text(part.type)))) throw new Error('此消息包含尚不支持编辑的结构化内容，不能安全编辑');
        draft = { target, messageID: message.id, text: authoritative.text, files: nativeEditFiles(authoritative.files) };
      }
      await idle();
      if (edit && options.canEditDraft?.() === false) throw new Error('当前草稿有待恢复操作，不能编辑历史消息');
      if (scope.message()?.id !== message.id) throw new Error('Selected message is unavailable');
      let staged!: NativeRevert;
      await dispatch({ kind: 'stage', messageID: message.id }, () => request(path('revert/stage'), 'POST', { messageID: message.id, files }), payload => {
        staged = nativeRevertFrom(payload);
        if (staged.messageID !== message.id) throw new Error('Invalid revert acknowledgement');
      });
      assertCurrent();
      options.onRevert?.(staged);
      if (draft) await options.onEditDraft?.(draft);
      await options.onChanged?.();
    }, invocation);
  }
  async function clear(invocation?: NativeHistoryInvocation) {
    return mutation(async dispatch => {
      await idle();
      // Redo is session-scoped: its original row may already have disappeared.
      await dispatch({ kind: 'clear', messageID: null }, () => request(path('revert'), 'DELETE'), () => {});
      assertCurrent(); options.onRevert?.(null); await options.onChanged?.();
    }, invocation);
  }
  async function forkAt(messageID: string | null, invocation?: NativeHistoryInvocation) {
    let opened: ChatTarget | undefined;
    const result = await mutation(async dispatch => {
      const authority = record(await request(`/api/session/${encodeURIComponent(target.id)}?${query(target.directory)}`));
      assertCurrent();
      const session = record(authority.data ?? authority);
      if (session.id !== target.id || text(record(session.location).directory ?? session.directory) !== target.directory) throw new Error('Invalid session fork authority');
      if (messageID !== null) { const { message } = await selected(); if (message.id !== messageID) throw new Error('Fork target is unavailable'); }
      let rows: Array<{ id: string; type: string; finish?: string; status?: string }> = [];
      let cursor = '', found = messageID === null && !scope.busy();
      const seen = new Set<string>();
      for (let page = 0; !found && page < 1000; page++) {
        const response = record(await request(`${path('message')}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=desc'}`));
        assertCurrent();
        if (!Array.isArray(response.data)) throw new Error('Invalid fork history');
        const batch = response.data.map(record).map(row => ({ id: text(row.id), type: text(row.type), finish: text(row.finish), status: text(row.status) }));
        if (batch.some(row => !row.id || !row.type)) throw new Error('Invalid fork history');
        rows = [...batch.reverse(), ...rows];
        if (messageID ? rows.some(row => row.id === messageID) : rows.some(row => ['user', 'shell', 'idle'].includes(row.type))) { found = true; break; }
        const next = text(record(response.cursor).next);
        if (!next || batch.length < 100) break;
        if (seen.has(next)) throw new Error('Fork history cursor did not advance');
        seen.add(next); cursor = next;
      }
      if (!found || messageID !== null && scope.message()?.id !== messageID) throw new Error('Fork target is unavailable');
      const before = resolveNativeForkBoundary(rows, messageID ?? undefined, scope.busy());
      await dispatch({ kind: 'fork', messageID }, () => request(path('fork'), 'POST', before ? { before } : {}), payload => {
        const value = record(payload), forked = record(value.data ?? value);
        const directory = text(record(forked.location).directory ?? forked.directory);
        if (!text(forked.id) || !directory) throw new Error('Invalid fork acknowledgement');
        opened = { kind: 'session', id: text(forked.id), directory, title: text(forked.title) || target.title };
      });
    }, invocation);
    if (result.status === 'accepted' && current() && invocation?.current() !== false && opened) {
      try { options.onOpenChat?.(opened); }
      catch (error) { return { ...result, target: opened, error }; }
    }
    return { ...result, ...(opened ? { target: opened } : {}) };
  }
  return {
    current,
    pending: () => mutations.has(lock),
    unknown: () => mutations.get(lock)?.unknown === true,
    stage: (files = true, invocation?: NativeHistoryInvocation) => stageSelected(files, invocation),
    clear,
    forkAt,
    /** Stage first, preserve the source; a new send commits through the chat owner. */
    async edit() {
      await legacy(stageSelected(false, undefined, true));
    },
    async revert(files = true) {
      await legacy(stageSelected(files));
    },
    async redo() {
      await legacy(clear());
    },
    async fork() {
      const message = scope.message();
      if (!message?.id) throw new Error('Selected message is unavailable');
      await legacy(forkAt(message.id));
    },
  };
}
