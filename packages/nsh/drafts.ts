import { batch, signal, Storage, untracked, type Signal } from 'nsh';
import { record, type Attachment, type ChatTarget, type CompiledSubmission, type QueueEdit, type Submission } from './model';
import { editNativeReferences, insertNativeReference, sameReferenceScope, validateNativeReferences, type NativeReference, type ReferenceCandidate, type ReferenceKind, type ReferenceScope, type ScopedReferenceDocument } from './composer-references';

type DraftRecord = { version: 1; revision: number; draft: string; references: NativeReference[]; attachments: Attachment[]; pendingSend: Submission | null; queueEdit: QueueEdit | null };
type Lane = { tail: Promise<unknown>; owner: number; flush?: () => Promise<void> };
// These lanes serialize actual Storage operations; they are not the draft data store.
const lanes = new Map<string, Lane>();
let nextOwner = 0;

export const draftKey = (hostID: string, target: ChatTarget) => `nsh:chat-draft:v1:${encodeURIComponent(JSON.stringify([hostID, target.directory, target.kind, target.id]))}`;
const sameFiles = (left: Attachment[], right: Attachment[]) => left.length === right.length && left.every((file, index) => file.uri === right[index]?.uri && file.name === right[index]?.name && file.mime === right[index]?.mime);
export const sameAttachment = (left: Attachment, right: Attachment) => left.uri === right.uri && left.name === right.name && left.mime === right.mime;
const sameReferences = (left: readonly NativeReference[], right: readonly NativeReference[]) => left.length === right.length && left.every((ref, index) => {
  const other = right[index];
  return !!other && ref.kind === other.kind && ref.value === other.value && ref.label === other.label && ref.display === other.display && ref.start === other.start && ref.end === other.end && ref.directory === other.directory && ref.description === other.description;
});

function referenceKind(value: unknown): ReferenceKind {
  switch (value) {
    case 'file': case 'directory': case 'agent': case 'skill': case 'session': return value;
    default: throw new Error('Invalid saved reference kind');
  }
}
function referencesFrom(value: unknown, text: string): NativeReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid saved references');
  const references = value.map(item => {
    const row = record(item);
    if (typeof row.value !== 'string' || typeof row.label !== 'string' || typeof row.display !== 'string' || typeof row.start !== 'number' || typeof row.end !== 'number') throw new Error('Invalid saved reference');
    return { kind: referenceKind(row.kind), value: row.value, label: row.label, display: row.display, start: row.start, end: row.end,
      ...(typeof row.directory === 'string' ? { directory: row.directory } : {}), ...(typeof row.description === 'string' ? { description: row.description } : {}) };
  });
  return validateNativeReferences({ text, references });
}
function referenceDocumentFrom(value: unknown, text: string, scope: ReferenceScope): ScopedReferenceDocument {
  const row = record(value), saved = record(row.scope);
  if (row.text !== text || saved.host !== scope.host || saved.draft !== scope.draft || saved.directory !== scope.directory) throw new Error('Invalid saved reference scope');
  return { text, scope: { ...scope }, references: referencesFrom(row.references, text) };
}

function filesFrom(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid saved attachment metadata');
  return value.map(item => {
    const file = record(item);
    if (typeof file.uri !== 'string' || !file.uri || typeof file.name !== 'string' || typeof file.mime !== 'string' || /^data:/i.test(file.uri)) throw new Error('附件草稿只能保存有效文件引用，不能保存文件正文');
    return { uri: file.uri, name: file.name, mime: file.mime };
  });
}
function compiledFrom(value: unknown): CompiledSubmission {
  const input = record(value);
  if (typeof input.text !== 'string') throw new Error('Invalid saved compiled submission');
  const compiled: CompiledSubmission = { text: input.text };
  if (input.files !== undefined) {
    if (!Array.isArray(input.files) || input.files.some(file => typeof record(file).uri !== 'string' || !record(file).uri || /^data:/i.test(String(record(file).uri)))) throw new Error('Invalid saved compiled file references');
    compiled.files = input.files.map(file => ({ uri: record(file).uri as string, ...(typeof record(file).name === 'string' ? { name: record(file).name as string } : {}) }));
  }
  if (input.agents !== undefined) {
    if (!Array.isArray(input.agents) || input.agents.some(item => typeof record(item).name !== 'string')) throw new Error('Invalid saved agent attachments');
    compiled.agents = input.agents.map(item => ({ name: record(item).name as string }));
  }
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills) || input.skills.some(item => typeof record(item).id !== 'string')) throw new Error('Invalid saved skill attachments');
    compiled.skills = input.skills.map(item => ({ id: record(item).id as string }));
  }
  if (input.metadata !== undefined) {
    if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) throw new Error('Invalid saved submission metadata');
    // Keep only JSON input data. Credentials and arbitrary native runtime config
    // never belong to a compiled submission, even when supplied by a caller.
    const json = JSON.stringify(input.metadata, (key, entry: unknown) => {
      if (/^(authorization|password|clientToken|accessToken|apiKey|secret|bearerToken)$/i.test(key)) throw new Error('凭据不得写入草稿存储');
      return entry;
    });
    compiled.metadata = record(JSON.parse(json));
  }
  return compiled;
}
function submissionFrom(value: unknown, scope: ReferenceScope): Submission | null {
  if (value === null || value === undefined) return null;
  const input = record(value);
  if (typeof input.id !== 'string' || !input.id || typeof input.text !== 'string' || !['queue', 'steer'].includes(String(input.delivery)) || typeof input.uncertain !== 'boolean') throw new Error('Invalid saved pending send');
  const next: Submission = { id: input.id, text: input.text, files: filesFrom(input.files), delivery: input.delivery as Submission['delivery'], uncertain: input.uncertain };
  if (input.command !== undefined) {
    const command = record(input.command);
    if (typeof command.name !== 'string' || typeof command.text !== 'string') throw new Error('Invalid saved command');
    next.command = { name: command.name, text: command.text };
  }
  if (input.inputMode !== undefined) {
    if (input.inputMode !== 'normal' && input.inputMode !== 'shell') throw new Error('Invalid saved input mode');
    next.inputMode = input.inputMode;
  }
  if (input.compiled !== undefined) next.compiled = compiledFrom(input.compiled);
  if (input.references !== undefined) next.references = referenceDocumentFrom(input.references, input.text, scope);
  if (input.preparedText !== undefined) {
    if (typeof input.preparedText !== 'string') throw new Error('Invalid saved prepared text');
    next.preparedText = input.preparedText;
  }
  return next;
}
function queueEditFrom(value: unknown): QueueEdit | null {
  if (value === null || value === undefined) return null;
  const row = record(value);
  if (typeof row.id !== 'string' || !row.id || typeof row.text !== 'string') throw new Error('Invalid saved queue edit');
  return { id: row.id, text: row.text, files: filesFrom(row.files) };
}
function decode(raw: string | null, scope: ReferenceScope): DraftRecord {
  if (raw === null) return { version: 1, revision: 0, draft: '', references: [], attachments: [], pendingSend: null, queueEdit: null };
  const value = record(JSON.parse(raw));
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.draft !== 'string') throw new Error('Invalid saved draft version');
  return { version: 1, revision: Number(value.revision), draft: value.draft, references: referencesFrom(value.references, value.draft), attachments: filesFrom(value.attachments), pendingSend: submissionFrom(value.pendingSend, scope), queueEdit: queueEditFrom(value.queueEdit) };
}

/** One native durable draft partition. Setters do no JSON, Storage or network work. */
export function openDraft(hostID: string, target: ChatTarget) {
  const key = draftKey(hostID, target), owner = ++nextOwner;
  const scope: ReferenceScope = { host: hostID, draft: key, directory: target.directory };
  const existing = lanes.get(key);
  // Reserve the previous visible page's last write before this page's read.
  if (existing?.flush) void existing.flush().catch(() => {});
  const lane: Lane = existing ?? { tail: Promise.resolve(), owner };
  lane.owner = owner; lanes.set(key, lane);
  const status = signal<'loading' | 'ready' | 'error'>('loading'), error = signal('');
  let revision = 0, storedRevision = 0, dirty = false, hydrated = false;
  let restoreFlight: Promise<void>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const versions = { draft: 0, references: 0, attachments: 0, pendingSend: 0, queueEdit: 0 };
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = lane.tail.catch(() => {}).then(work); lane.tail = task;
    return task;
  }
  function tracked<T>(name: keyof typeof versions, initial: T): { value: Signal<T>; restore: (next: T) => void } {
    const source = signal(initial);
    const value = Object.assign(() => source(), {
      set(next: T) {
        if (untracked(source) === next) return;
        source.set(next); versions[name]++; revision++; dirty = true;
        if (!timer) timer = setTimeout(() => { timer = undefined; void flush().catch(() => {}); }, 300);
      },
      update(work: (previous: T) => T) { value.set(work(untracked(source))); },
    });
    return { value, restore: source.set.bind(source) };
  }
  const draftField = tracked('draft', ''), filesField = tracked<Attachment[]>('attachments', []);
  const referenceField = tracked<NativeReference[]>('references', []);
  const pendingField = tracked<Submission | null>('pendingSend', null), editField = tracked<QueueEdit | null>('queueEdit', null);
  const references = () => referenceField.value();
  const document = (): ScopedReferenceDocument => ({ text: draftField.value(), references: references(), scope: { ...scope } });
  function setDocument(next: ScopedReferenceDocument) {
    if (!sameReferenceScope(next.scope, scope)) throw new Error('native-reference-scope-mismatch');
    const valid = validateNativeReferences(next);
    if (valid.some(ref => ref.scope && !sameReferenceScope(ref.scope, scope))) throw new Error('native-reference-scope-mismatch');
    batch(() => {
      draftField.value.set(next.text);
      if (!sameReferences(untracked(referenceField.value), valid)) referenceField.value.set(valid.map(ref => ({ ...ref, ...(ref.scope ? { scope: { ...ref.scope } } : {}) })));
    });
  }
  const setDraftText = (next: string) => setDocument({ ...editNativeReferences(untracked(document), next), scope });
  const insertReference = (candidate: ReferenceCandidate, start?: number, end?: number) => setDocument({ ...insertNativeReference(untracked(document), candidate, start, end), scope });
  // Keep legacy draft.set consumers on the same atomic text + reference path.
  const draft = Object.assign(() => draftField.value(), { set: setDraftText, update: (work: (previous: string) => string) => setDraftText(work(untracked(draftField.value))) });
  const attachments = filesField.value, pendingSend = pendingField.value, queueEdit = editField.value;
  function restore() {
    const flight = enqueue(async () => {
      try {
        const saved = decode(await Storage.getItem(key), scope);
        storedRevision = saved.revision;
        // Separate field CAS: typing during restore cannot erase a pending receipt.
        if (!versions.draft && !versions.references) batch(() => { draftField.restore(saved.draft); referenceField.restore(saved.references); });
        if (!versions.attachments) filesField.restore(saved.attachments);
        if (!versions.pendingSend) pendingField.restore(saved.pendingSend);
        if (!versions.queueEdit) editField.restore(saved.queueEdit);
        hydrated = true; status.set('ready'); error.set('');
      } catch (failure) { status.set('error'); error.set('草稿恢复失败，已保留现有输入'); throw failure; }
    });
    restoreFlight = flight;
    return flight;
  }
  const ready = restore();
  // Restoration failure is observable without an unhandled startup rejection.
  void ready.catch(() => {});
  function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (lane.owner !== owner) return Promise.resolve();
    return enqueue(async () => {
      if (!hydrated) throw new Error('草稿尚未成功恢复，不能覆盖持久记录');
      if (!dirty) return;
      const writtenRevision = revision;
      try {
        const saved = decode(await Storage.getItem(key), scope);
        if (saved.revision !== storedRevision) throw new Error('草稿已由另一页面更新');
        const snapshot: DraftRecord = { version: 1, revision: storedRevision + 1, draft: untracked(draft), references: referencesFrom(untracked(references), untracked(draft)), attachments: filesFrom(untracked(attachments)), pendingSend: submissionFrom(untracked(pendingSend), scope), queueEdit: queueEditFrom(untracked(queueEdit)) };
        const json = JSON.stringify(snapshot);
        if (json.length > 750_000) throw new Error('草稿超过本机存储容量限制');
        await Storage.setItem(key, json);
        storedRevision = snapshot.revision;
        if (revision === writtenRevision) dirty = false;
        status.set('ready'); error.set('');
      } catch (failure) { status.set('error'); error.set('草稿保存失败，输入仍保留在当前页面'); throw failure; }
    });
  }
  lane.flush = flush;
  async function retry() {
    if (!hydrated) await restore();
    await flush();
  }
  function close() {
    const finished = flush();
    if (lane.owner === owner) lane.flush = undefined;
    void finished.finally(() => { if (lane.owner === owner && !lane.flush && lanes.get(key) === lane) lanes.delete(key); }).catch(() => {});
    return finished;
  }
  return { key, scope: { ...scope }, draft, references, document, setDocument, setDraftText, insertReference, attachments, pendingSend, queueEdit, status, error, ready, whenReady: () => restoreFlight, restore, retry, flush, close,
    revision: () => revision, draftRevision: () => versions.draft + versions.references,
    matchesDocument: (text: string, refs: readonly NativeReference[] = []) => untracked(draft) === text && sameReferences(untracked(references), refs),
    matches: (text: string, files: Attachment[], refs: readonly NativeReference[] = []) => untracked(draft) === text && sameFiles(untracked(attachments), files) && sameReferences(untracked(references), refs),
  };
}
