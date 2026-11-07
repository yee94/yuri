import { effect, signal, Storage, untracked } from 'nsh';
import { openDraft, draftKey, sameAttachment } from './drafts';
import { compileNativePrompt, magicCommand } from './composer';
import { sameReferenceScope, validateNativeReferences, type ReferenceScope, type ScopedReferenceDocument } from './composer-references';
import { app, captureHostRequest, epoch, isCurrentHostScope, type createChat, type SendOptions } from './state';
import { createPageOperations, type PageOperation } from './page-operations';
import { query, sessionPath } from './runtime';
import { activeFrom, id, inboxFrom, nameOf, record, rowsFrom, slashCommand, text, unwrap, type Attachment, type ChatTarget, type Project, type Submission } from './model';

export type NativeNewSessionSelection = { model?: { providerID: string; id: string; variant?: string }; agent?: string };
type Receipt = { version: 1; revision: number; selection: NativeNewSessionSelection; admission?: 'unknown' | 'acknowledged'; configuration?: { model?: 'unknown' | 'acknowledged'; agent?: 'unknown' | 'acknowledged' } } & (
  | { phase: 'draft' }
  | { phase: 'creating'; inputID: string }
  | { phase: 'created' | 'installed'; inputID: string; target: ChatTarget }
);
type Lane = { tail: Promise<unknown>; owner: number };
const lanes = new Map<string, Lane>();
let nextOwner = 0;
const localTarget = (directory: string): ChatTarget => ({ kind: 'session', id: 'new-session-draft', title: '', directory });
const receiptKey = (hostID: string, directory: string) => `nsh:new-session:v1:${encodeURIComponent(JSON.stringify([hostID, directory]))}`;

function selectionFrom(value: unknown): NativeNewSessionSelection {
  const row = record(value), model = record(row.model);
  if (row.agent !== undefined && (typeof row.agent !== 'string' || !row.agent)) throw new Error('new-session-invalid-selection');
  if (row.model !== undefined && (!text(model.providerID) || !text(model.id) || model.variant !== undefined && typeof model.variant !== 'string')) throw new Error('new-session-invalid-selection');
  return { ...(row.agent ? { agent: text(row.agent) } : {}), ...(row.model !== undefined ? { model: { providerID: text(model.providerID), id: text(model.id), ...(model.variant !== undefined ? { variant: text(model.variant) } : {}) } } : {}) };
}
function receiptFrom(raw: string | null, directory: string): Receipt {
  if (raw === null) return { version: 1, revision: 0, phase: 'draft', selection: {} };
  const row = record(JSON.parse(raw));
  if (row.version !== 1 || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) throw new Error('new-session-invalid-receipt');
  if (row.admission !== undefined && row.admission !== 'unknown' && row.admission !== 'acknowledged') throw new Error('new-session-invalid-receipt');
  const configuration = record(row.configuration);
  if (row.configuration !== undefined && (!row.configuration || typeof row.configuration !== 'object' || Array.isArray(row.configuration) || Object.keys(configuration).some(key => !['model', 'agent'].includes(key)) || Object.values(configuration).some(value => value !== 'unknown' && value !== 'acknowledged'))) throw new Error('new-session-invalid-receipt');
  const base = { version: 1 as const, revision: Number(row.revision), selection: selectionFrom(row.selection),
    ...(row.admission ? { admission: row.admission as 'unknown' | 'acknowledged' } : {}),
    ...(row.configuration !== undefined ? { configuration: configuration as Receipt['configuration'] } : {}) };
  if (row.phase === 'draft') return { ...base, phase: 'draft' };
  if (!text(row.inputID)) throw new Error('new-session-invalid-receipt');
  if (row.phase === 'creating') return { ...base, phase: 'creating', inputID: text(row.inputID) };
  const target = record(row.target);
  if ((row.phase !== 'created' && row.phase !== 'installed') || target.kind !== 'session' || !text(target.id) || target.directory !== directory || typeof target.title !== 'string') throw new Error('new-session-invalid-receipt');
  return { ...base, phase: row.phase, inputID: text(row.inputID), target: { kind: 'session', id: text(target.id), title: target.title, directory } };
}
function relocate(document: ScopedReferenceDocument, scope: ReferenceScope): ScopedReferenceDocument {
  validateNativeReferences(document);
  if (document.scope.host !== scope.host || document.scope.directory !== scope.directory || document.references.some(ref => ref.scope && !sameReferenceScope(ref.scope, document.scope))) throw new Error('native-reference-scope-mismatch');
  return { text: document.text, scope: { ...scope }, references: document.references.map(ref => ({ ...ref, ...(ref.scope ? { scope: { ...scope } } : {}) })) };
}

export type NativeNewSessionHandoff = { target: ChatTarget; hostID: string; generation: number; inputID: string };
type NativeChat = ReturnType<typeof createChat>;

/** Only consumes an already installed stable-ID submission; never recreates it or POSTs a prompt itself. */
export async function sendNewSessionHandoff(chat: NativeChat, handoff: NativeNewSessionHandoff, options: SendOptions = {}, send?: ReturnType<typeof captureHostRequest>, authority?: {
  operation: PageOperation; source: { ownedScope: () => boolean; hostID: string; generation: number }; reconcileOnly: boolean;
}) {
  const request = send ?? captureHostRequest();
  await chat.draftReady;
  const current = () => chat.active() && (authority
    ? authority.source.ownedScope() && authority.source.hostID === handoff.hostID && authority.source.generation === handoff.generation
      && authority.operation.current() && chat.messageScope.hostID === handoff.hostID && chat.messageScope.generation === authority.operation.generation
    : isCurrentHostScope(handoff.generation, handoff.hostID));
  if (!current()) return false;
  if (handoff.target.kind !== 'session' || chat.referenceScope.draft !== draftKey(handoff.hostID, handoff.target) || chat.referenceScope.directory !== handoff.target.directory) throw new Error('new-session-handoff-scope-mismatch');
  if (chat.pendingSend() && chat.pendingSend()!.id !== handoff.inputID) throw new Error('new-session-handoff-input-mismatch');
  // Share createChat's startup recovery flight. It may have admitted/cleared the
  // durable input before this navigation callback gets its first turn.
  if (await chat.recoverPendingSend()) return current();
  if (!current()) return false;
  const pending = chat.pendingSend();
  if (pending && pending.id !== handoff.inputID) throw new Error('new-session-handoff-input-mismatch');
  // An absent receipt may already be admitted or definitively rejected. Reinstalling
  // here would turn a remount into a duplicate command or prompt.
  if (!pending || pending.uncertain || authority?.reconcileOnly) {
    if (!request) throw new Error('new-session-request-owner-required');
    // A missing local receipt alone is never success. Confirm the exact stable
    // ID from authority, without reinstalling a prompt or replaying a command.
    try {
      const inbox = inboxFrom(await request(`${sessionPath(handoff.target.id, 'inbox')}?${query(handoff.target.directory)}`));
      if (!current()) return false;
      if (inbox.some(item => item.id === handoff.inputID)) return !pending?.command && pending?.inputMode !== 'shell';
    } catch { if (!current()) return false; }
    try {
      const value = record(unwrap(await request(`${sessionPath(handoff.target.id, `message/${encodeURIComponent(handoff.inputID)}`)}?${query(handoff.target.directory)}`)));
      return current() && !pending?.command && pending?.inputMode !== 'shell' && (record(value.info).id ?? value.id) === handoff.inputID;
    } catch (failure) { if (record(failure).status === 404 || !current()) return false; throw failure; }
  }
  const prepare = options.prepare ?? (pending.inputMode !== 'shell' && (magicCommand(pending.text) || pending.references?.references.length) ? (input: Parameters<typeof compileNativePrompt>[0]) => {
    if (!request) throw new Error('new-session-request-owner-required');
    return compileNativePrompt(input, request);
  } : undefined);
  const admitted = await chat.retrySend({ ...options, ...(prepare ? { prepare } : {}) });
  return admitted === true && current();
}

/** Headless draft owner. Opening/typing/selecting never creates a remote session. */
export function openNativeNewSession(options: { project?: Project; directory?: string; active: () => boolean; operation?: () => PageOperation | null }) {
  const lifetime = createPageOperations();
  const operation = signal<PageOperation | null>(null);
  const connection = app.connection();
  if (!connection) throw new Error('new-session-no-host');
  const hostID = connection.id;
  const generation = epoch(), directory = options.directory ?? options.project?.path ?? '';
  const project: Project = { id: options.project?.id ?? '', name: options.project?.name ?? nameOf(directory), path: directory };
  const durable = openDraft(hostID, localTarget(directory)), key = receiptKey(hostID, directory), owner = ++nextOwner;
  const lane = lanes.get(key) ?? { tail: Promise.resolve(), owner };
  lane.owner = owner; lanes.set(key, lane);
  const receipt = signal<Receipt>({ version: 1, revision: 0, phase: 'draft', selection: {} });
  const status = signal<'loading' | 'ready' | 'error'>('loading'), error = signal(''), submitting = signal(false);
  let alive = true, hydrated = false, snapshotRevision = 0, restoredRemote = false;
  const knownCreated = signal<ChatTarget | null>(null);
  let submitFlight: Promise<NativeNewSessionHandoff | null> | undefined;
  let submitOperation: PageOperation | null = null;
  let firstOperation: PageOperation | null = null;
  let retired = false, externalOperation = false;
  const ownsJournal = () => alive && lane.owner === owner;
  const ownedScope = () => {
    const next = app.connection();
    if (next?.id !== connection.id || next?.url !== connection.url || next?.authorizationID !== connection.authorizationID) retired = true;
    return ownsJournal() && !retired;
  };
  const current = () => ownedScope() && operation()?.current() === true && options.active();
  function assignOperation(next: PageOperation | null) {
    if (!ownedScope() || next && (!next.current() || next.scope?.hostID && next.scope.hostID !== hostID)) { operation.set(null); return false; }
    if (operation() === next) return true;
    operation.set(next); return true;
  }
  function replaceOperation(next: PageOperation | null) { externalOperation = true; return assignOperation(next); }
  effect(() => { app.connection(); const next = options.operation ? options.operation() : lifetime.operation(); untracked(() => { ownedScope(); if (!externalOperation) assignOperation(next); }); });
  function captureOperation(requireActive = true) {
    const assigned = operation();
    const current = () => ownedScope() && operation() === assigned && assigned?.current() === true && (!requireActive || options.active());
    if (!assigned || !current()) throw new Error('new-session-scope-changed');
    return Object.freeze({ ...assigned, current, request: async (path: string, method = 'GET', body?: unknown) => {
      if (!current()) throw new Error('new-session-scope-changed');
      try { return await assigned.request(path, method, body); }
      catch (failure) { if (!current()) throw new Error('new-session-scope-changed'); throw failure; }
    } });
  }
  const assertCurrent = (captured: Pick<PageOperation, 'current'>) => { if (!captured.current()) throw new Error('new-session-scope-changed'); };
  function enqueue<T>(work: () => Promise<T>) {
    const flight = lane.tail.catch(() => {}).then(work); lane.tail = flight; return flight;
  }
  const restore = () => enqueue(async () => {
    try {
      const saved = receiptFrom(await Storage.getItem(key), directory);
      if (!hydrated) restoredRemote = saved.phase !== 'draft';
      receipt.set(saved); hydrated = true; status.set('ready'); error.set('');
    }
    catch (failure) { status.set('error'); error.set('new-session-restore-failed'); throw failure; }
  });
  let restoration = Promise.all([durable.ready, restore()]).then(() => {});
  const ready = restoration;
  void ready.catch(() => {});
  async function write(next: Receipt, captured: Pick<PageOperation, 'current'>, allowRetired = false) {
    return enqueue(async () => {
      if (!hydrated) throw new Error('new-session-not-restored');
      if (!(allowRetired ? lane.owner === owner : ownsJournal())) throw new Error('new-session-source-retired');
      if (!allowRetired) assertCurrent(captured);
      const stored = receiptFrom(await Storage.getItem(key), directory);
      if (!allowRetired) assertCurrent(captured);
      if (stored.revision !== next.revision) throw new Error('new-session-receipt-conflict');
      const saved: Receipt = { ...next, revision: stored.revision + 1 };
      await Storage.setItem(key, JSON.stringify(saved));
      receipt.set(saved); return saved;
    });
  }
  async function select(selection: NativeNewSessionSelection) {
    const captured = captureOperation();
    await restoration; assertCurrent(captured);
    if (receipt().phase !== 'draft' || submitting()) throw new Error('new-session-selection-frozen');
    await write({ ...receipt(), selection: selectionFrom(selection) }, captured);
  }
  const setDraftText = (value: string) => { if (!current()) return false; durable.setDraftText(value); return true; };
  const setAttachments = (value: Attachment[]) => { if (!current()) return false; durable.attachments.set(value.map(file => ({ ...file }))); return true; };
  const insertReference = (...args: Parameters<typeof durable.insertReference>) => { if (!current()) return false; durable.insertReference(...args); return true; };
  async function configure(target: ChatTarget, selection: NativeNewSessionSelection, captured: PageOperation, readOnly: boolean) {
    const request = captured.request;
    // A newly created session is idle. Apply the captured selection once, before
    // handing ownership to Chat; retries of an installed inbox never reapply it.
    if (selection.model && !readOnly && !receipt().configuration?.model) {
      assertCurrent(captured);
      const { providerID, id, variant } = selection.model;
      await write({ ...receipt(), configuration: { ...receipt().configuration, model: 'unknown' } }, captured);
      await request(`${sessionPath(target.id, 'model')}?${query(directory)}`, 'POST', { model: { providerID, id, ...(variant ? { variant } : {}) } });
      await write({ ...receipt(), configuration: { ...receipt().configuration, model: 'acknowledged' } }, captured);
    }
    if (selection.agent && !readOnly && !receipt().configuration?.agent) {
      assertCurrent(captured);
      await write({ ...receipt(), configuration: { ...receipt().configuration, agent: 'unknown' } }, captured);
      await request(`${sessionPath(target.id, 'agent')}?${query(directory)}`, 'POST', { agent: selection.agent });
      await write({ ...receipt(), configuration: { ...receipt().configuration, agent: 'acknowledged' } }, captured);
    }
    assertCurrent(captured);
    if (!selection.model && !selection.agent) return;
    const authority = record(unwrap(await request(`/api/session/${encodeURIComponent(target.id)}?${query(directory)}`)));
    assertCurrent(captured);
    const model = record(authority.model);
    if (authority.id !== target.id || selection.agent && authority.agent !== selection.agent || selection.model && (model.id !== selection.model.id || model.providerID !== selection.model.providerID || text(model.variant) !== text(selection.model.variant))) throw new Error('new-session-selection-not-confirmed');
  }
  function submit(sendOptions: Pick<SendOptions, 'inputMode'> = {}): Promise<NativeNewSessionHandoff | null> {
    if (submitFlight) return submitFlight;
    let captured: ReturnType<typeof captureOperation>;
    try { captured = captureOperation(); } catch (failure) { return Promise.reject(failure); }
    const assigned = operation()!;
    firstOperation ??= assigned;
    submitOperation = assigned;
    const flight = (async () => {
      submitting.set(true); error.set('');
      try {
        await restoration; assertCurrent(captured);
        if (!directory) throw new Error('new-session-directory-required');
        let value = receipt();
        if (value.phase === 'draft') { firstOperation = assigned; restoredRemote = false; }
        const readOnly = value.phase !== 'draft' && (firstOperation !== assigned || restoredRemote);
        if (value.phase === 'draft') {
          if (!durable.draft().trim() && !durable.attachments().length) return null;
          if (durable.queueEdit()) throw new Error('new-session-queue-edit-blocked');
          let submission = durable.pendingSend();
          if (!submission) {
            const document = untracked(durable.document), mode = sendOptions.inputMode ?? 'normal';
            if (mode === 'shell' && (document.references.length || durable.attachments().length)) throw new Error('new-session-shell-references-unsupported');
            submission = { id: id(), text: document.text, files: durable.attachments().map(file => ({ ...file })), delivery: 'steer', uncertain: false, inputMode: mode, references: relocate(document, durable.scope) };
            if (mode !== 'shell' && !document.references.length && !magicCommand(document.text)) {
              const command = slashCommand(document.text); if (command) submission.command = command;
            }
            snapshotRevision = durable.draftRevision();
            durable.pendingSend.set(submission);
          }
          // Persist exact text/sidecars/files before the create write-ahead record.
          await durable.flush(); assertCurrent(captured);
          value = await write({ ...value, phase: 'creating', inputID: submission.id }, captured);
          assertCurrent(captured);
          knownCreated.set(null);
          const response = record(unwrap(await captured.request('/api/session', 'POST', { location: { directory: project.path } })));
          if (!text(response.id)) throw new Error('Server returned no session ID');
          const created: ChatTarget = { kind: 'session', id: text(response.id), title: text(response.title) || project.name, directory };
          knownCreated.set(created);
          // Retain a known target even if this page was closed during creation.
          value = await write({ ...value, phase: 'created', inputID: submission.id, target: created }, captured, true);
        } else if (value.phase === 'creating') {
          // Session.create has no caller idempotency key. Unknown is not permission
          // to create again, even after process restart or a repeated plus press.
          const created = knownCreated();
          if (!created) throw new Error('new-session-create-outcome-unknown');
          value = await write({ ...value, phase: 'created', target: created }, captured);
        }
        assertCurrent(captured);
        if (value.phase !== 'created' && value.phase !== 'installed') throw new Error('new-session-invalid-receipt');
        if (value.phase === 'created') {
          const submission = durable.pendingSend();
          if (!submission || submission.id !== value.inputID || !submission.references) throw new Error('new-session-snapshot-missing');
          await configure(value.target, value.selection, captured, readOnly); assertCurrent(captured);
          const destination = openDraft(hostID, value.target);
          try {
            await destination.ready; assertCurrent(captured);
            const references = relocate(submission.references, destination.scope);
            const transferred: Submission = { ...submission, files: submission.files.map(file => ({ ...file })), references };
            // Resume a crash/write failure between destination flush and the
            // installed receipt without overwriting an unrelated destination.
            const staged = destination.pendingSend()?.id === value.inputID && destination.matches(submission.text, submission.files, references.references) && !destination.queueEdit();
            if (!staged) {
              if (destination.pendingSend() || destination.queueEdit() || destination.draft() || destination.attachments().length) throw new Error('new-session-destination-not-empty');
              destination.setDocument(references); destination.attachments.set(transferred.files); destination.pendingSend.set(transferred);
            }
            await destination.flush(); assertCurrent(captured);
            value = await write({ ...receipt(), phase: 'installed', target: value.target, inputID: value.inputID }, captured);
          } finally { await destination.close(); }
        }
        assertCurrent(captured);
        if (value.phase !== 'installed') throw new Error('new-session-invalid-receipt');
        status.set('ready');
        return { target: { ...value.target }, hostID, generation, inputID: value.inputID };
      } catch (failure) {
        if (captured.current()) { status.set('error'); error.set(failure instanceof Error ? failure.message : 'new-session-submit-failed'); }
        throw failure;
      } finally { if (submitOperation === assigned) submitting.set(false); }
    })();
    submitFlight = flight;
    void flight.finally(() => { if (submitFlight === flight) submitFlight = undefined; if (!alive && lane.owner === owner) lanes.delete(key); }).catch(() => {});
    return flight;
  }
  /** Call only after Chat confirms admission. Later edits remain a separate draft. */
  async function complete(handoff: NativeNewSessionHandoff) {
    const capturedOperation = captureOperation(false);
    await restoration;
    assertCurrent(capturedOperation);
    const value = receipt(), captured = durable.pendingSend();
    if (value.phase !== 'installed' || value.inputID !== handoff.inputID || value.target.id !== handoff.target.id || value.target.directory !== handoff.target.directory || handoff.target.kind !== 'session' || handoff.hostID !== hostID || handoff.generation !== generation) throw new Error('new-session-handoff-input-mismatch');
    if (captured) {
      if (durable.draftRevision() === snapshotRevision && durable.matchesDocument(captured.text, captured.references?.references)) durable.setDocument({ text: '', references: [], scope: durable.scope });
      durable.attachments.set(durable.attachments().filter(file => !captured.files.some(sent => sameAttachment(file, sent))));
    }
    durable.pendingSend.set(null); await durable.flush();
    assertCurrent(capturedOperation);
    await write({ version: 1, revision: value.revision, phase: 'draft', selection: value.selection }, capturedOperation);
    knownCreated.set(null);
    status.set('ready'); error.set('');
  }
  async function retryStorage() {
    restoration = Promise.all([durable.retry(), !hydrated ? restore() : Promise.resolve()]).then(() => {});
    await restoration; status.set('ready'); error.set('');
  }
  /** Explicit recovery only: a user-selected, authoritative empty idle session. */
  async function recoverCreatedSession(sessionID: string) {
    const captured = captureOperation(), request = captured.request;
    await restoration; assertCurrent(captured);
    const value = receipt();
    if (value.phase !== 'creating' || submitting()) throw new Error('new-session-recovery-not-available');
    const selectedID = sessionID.trim();
    if (!selectedID) throw new Error('new-session-recovery-id-required');
    const [session, messages, inbox, active] = await Promise.all([
      request(`/api/session/${encodeURIComponent(selectedID)}?${query(directory)}`),
      request(`${sessionPath(selectedID, 'message')}?${query(directory)}&limit=1`),
      request(`${sessionPath(selectedID, 'inbox')}?${query(directory)}`),
      request('/api/session/active'),
    ]);
    assertCurrent(captured);
    const authority = record(unwrap(session));
    if (authority.id !== selectedID || (text(record(authority.location).directory) || text(authority.directory)) !== directory) throw new Error('new-session-recovery-directory-mismatch');
    if (rowsFrom(messages).length || rowsFrom(inbox).length || activeFrom(active, selectedID)) throw new Error('new-session-recovery-not-empty');
    const target: ChatTarget = { kind: 'session', id: selectedID, title: text(authority.title) || project.name, directory };
    knownCreated.set(target);
    await write({ ...value, phase: 'created', target }, captured);
    status.set('ready'); error.set('');
  }
  async function close() {
    alive = false;
    await submitFlight?.catch(() => {});
    await durable.close();
    if (lane.owner === owner && !submitFlight) lanes.delete(key);
  }
  async function noteAdmission(handoff: NativeNewSessionHandoff, phase: 'unknown' | 'acknowledged', captured: PageOperation) {
    await restoration; assertCurrent(captured);
    const value = receipt();
    if (value.phase !== 'installed' || value.inputID !== handoff.inputID || value.target.id !== handoff.target.id || handoff.hostID !== hostID || handoff.generation !== generation || handoff.target.directory !== directory) throw new Error('new-session-handoff-input-mismatch');
    if (value.admission === 'acknowledged' || value.admission === phase) return;
    await write({ ...value, admission: phase }, captured);
  }
  return { directory, hostID, generation, project: { ...project }, durable, ready, status, error, submitting, current, replaceOperation, captureOperation, operation, ownedScope, noteAdmission, admission: () => receipt().admission,
    selection: () => selectionFrom(receipt().selection),
    phase: () => receipt().phase, target: () => { const value = receipt(); return value.phase === 'created' || value.phase === 'installed' ? { ...value.target } : null; },
    creationUnknown: () => receipt().phase === 'creating' && !knownCreated(), inputID: () => { const value = receipt(); return value.phase === 'draft' ? durable.pendingSend()?.id : value.inputID; },
    setDraftText, setAttachments, insertReference, select, submit, complete, retryStorage, recoverCreatedSession, close };
}

export type NativeNewSessionOwner = ReturnType<typeof openNativeNewSession>;
export type NativeNewSessionPageHandoff = { receipt: NativeNewSessionHandoff; owner: NativeNewSessionOwner; release: () => Promise<void>; released: () => boolean };

/** Page cleanup and navigation handoff have separate, explicit ownership. */
export function createNativeNewSessionOwnership(options: Parameters<typeof openNativeNewSession>[0]) {
  const transferred = signal(false), released = signal(false);
  let attached = true, releaseFlight: Promise<void> | undefined, handoff: NativeNewSessionPageHandoff | undefined;
  const owner = openNativeNewSession({ ...options, active: () => attached && !transferred() && options.active() });
  function release() {
    if (!releaseFlight) releaseFlight = owner.close().finally(() => released.set(true));
    return releaseFlight;
  }
  function transfer(receipt: NativeNewSessionHandoff): NativeNewSessionPageHandoff {
    if (handoff) {
      if (handoff.receipt.inputID !== receipt.inputID || released()) throw new Error('new-session-handoff-input-mismatch');
      return handoff;
    }
    if (!owner.current() || owner.phase() !== 'installed' || owner.inputID() !== receipt.inputID || owner.hostID !== receipt.hostID || owner.generation !== receipt.generation || owner.target()?.id !== receipt.target.id || owner.directory !== receipt.target.directory) throw new Error('new-session-handoff-scope-mismatch');
    transferred.set(true);
    handoff = { receipt, owner, release, released };
    return handoff;
  }
  function reclaim(value: NativeNewSessionPageHandoff) {
    if (!attached || handoff !== value || released()) return false;
    handoff = undefined; transferred.set(false); return true;
  }
  function disposePage() { attached = false; return transferred() ? Promise.resolve() : release(); }
  return { owner, transfer, reclaim, disposePage, transferred, released, handoff: () => handoff };
}
