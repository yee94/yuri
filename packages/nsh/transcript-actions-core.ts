import { messageFrom, record, text, type Attachment, type ChatTarget, type Message, type Row } from './model';
import { query, type request, sessionPath } from './runtime';
import { resolveNativeForkBoundary } from '../ui/src/sync/session-fork-boundary';

export type NativeEditDraft = { target: ChatTarget; messageID: string; text: string; files: Attachment[] };
export type NativeRevert = { messageID: string; files?: Row[] };
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
};
const mutations = new Set<string>();

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
  async function mutation(work: () => Promise<void>) {
    assertCurrent();
    if (mutations.has(lock)) throw new Error('Session history action is pending');
    mutations.add(lock);
    let acquired = false;
    try { options.onPending?.(true); acquired = true; await work(); }
    finally { mutations.delete(lock); if (acquired) options.onPending?.(false); }
  }
  async function reconcileFailure() {
    if (!current()) return;
    options.onUncertain?.();
    // Unknown write results must reload authority, never masquerade as rollback.
    try { await options.onChanged?.(); } catch { /* Keep the original failure and last valid indicator. */ }
  }
  async function stage(messageID: string, files: boolean) {
    try {
      const value = nativeRevertFrom(await request(path('revert/stage'), 'POST', { messageID, files }));
      assertCurrent();
      if (value.messageID !== messageID) throw new Error('Invalid revert acknowledgement');
      return value;
    } catch (failure) { await reconcileFailure(); throw failure; }
  }
  return {
    current,
    pending: () => mutations.has(lock),
    /** Stage first, preserve the source; a new send commits through the chat owner. */
    async edit() {
      await mutation(async () => {
        if (!options.onEditDraft || options.canEditDraft?.() === false) throw new Error('当前草稿尚未就绪或有待恢复操作，不能编辑历史消息');
        await idle();
        const { message, raw } = await selected();
        if (raw.type !== 'user' || message.role !== 'user') throw new Error('Only user messages can be edited');
        const authoritative = messageFrom(raw);
        if (!authoritative) throw new Error('Selected message is unavailable');
        if (authoritative.content?.some(part => !['text', 'file'].includes(text(part.type)))) throw new Error('此消息包含尚不支持编辑的结构化内容，不能安全编辑');
        const draft = { target, messageID: message.id, text: authoritative.text, files: nativeEditFiles(authoritative.files) };
        await idle();
        if (options.canEditDraft?.() === false) throw new Error('当前草稿有待恢复操作，不能编辑历史消息');
        if (scope.message()?.id !== message.id) throw new Error('Selected message is unavailable');
        const value = await stage(message.id, false);
        options.onRevert?.(value);
        await options.onEditDraft(draft);
        await options.onChanged?.();
      });
    },
    async revert(files = true) {
      await mutation(async () => {
        await idle();
        const { message, raw } = await selected();
        if (raw.type !== 'user') throw new Error('Revert requires a user message');
        await idle();
        if (scope.message()?.id !== message.id) throw new Error('Selected message is unavailable');
        const value = await stage(message.id, files);
        options.onRevert?.(value);
        await options.onChanged?.();
      });
    },
    async redo() {
      await mutation(async () => {
        await idle();
        // Redo is session-scoped: its original row may already have disappeared.
        try { await request(path('revert'), 'DELETE'); }
        catch (failure) { await reconcileFailure(); throw failure; }
        assertCurrent();
        options.onRevert?.(null);
        await options.onChanged?.();
      });
    },
    async fork() {
      await mutation(async () => {
        const { message } = await selected();
        let rows: Array<{ id: string; type: string; finish?: string; status?: string }> = [];
        let cursor = '', found = false;
        const seen = new Set<string>();
        for (let page = 0; page < 1000; page++) {
          const response = record(await request(`${path('message')}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=desc'}`));
          assertCurrent();
          if (!Array.isArray(response.data)) throw new Error('Invalid fork history');
          const batch = response.data.map(record).map(row => ({ id: text(row.id), type: text(row.type), finish: text(row.finish), status: text(row.status) }));
          if (batch.some(row => !row.id || !row.type)) throw new Error('Invalid fork history');
          rows = [...batch.reverse(), ...rows];
          if (rows.some(row => row.id === message.id)) { found = true; break; }
          const next = text(record(response.cursor).next);
          if (!next || batch.length < 100) break;
          if (seen.has(next)) throw new Error('Fork history cursor did not advance');
          seen.add(next); cursor = next;
        }
        if (!found || scope.message()?.id !== message.id) throw new Error('Fork target is unavailable');
        const before = resolveNativeForkBoundary(rows, message.id, scope.busy());
        assertCurrent();
        const value = record(await request(path('fork'), 'POST', before ? { before } : {}));
        assertCurrent();
        const forked = record(value.data ?? value);
        if (!text(forked.id)) throw new Error('Invalid fork acknowledgement');
        options.onOpenChat?.({ kind: 'session', id: text(forked.id), directory: text(forked.directory) || target.directory, title: text(forked.title) || target.title });
      });
    },
  };
}
