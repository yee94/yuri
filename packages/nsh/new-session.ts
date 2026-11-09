import { effect, platform, signal, Storage, untracked } from 'nsh';
import { openDraft, draftKey, sameAttachment, localMagicSubmission, type DurableSubmission as ContextSubmission } from './drafts';
import type { NativeLocalCommandInvocation, NativeLocalCommandOutcome } from './composer-local-commands';
import { compileNativePrompt, magicCommand } from './composer';
import { compileDesktopGitContext, desktopGitDraftAuthority, sameDesktopGitContext, type DesktopGitContextInput, type DesktopGitStageConfirmation, type DesktopGitStageResult } from './desktop-git-dispatch';
import { referenceRoute, sameReferenceScope, validateNativeReferences, type ReferenceScope, type ScopedReferenceDocument } from './composer-references';
import { app, captureHostRequest, epoch, isCurrentHostScope, type createChat, type SendOptions } from './state';
import { createPageOperations, type PageOperation } from './page-operations';
import { bindRequest, query, sessionPath } from './runtime';
import { createNewSessionWriterCustody, type NewSessionWriterAdmission } from './new-session-writer';
import type { DesktopWriterClaim } from './desktop-writer-core';
import { sameRuntimeScope } from './runtime-scope';
import { activeFrom, id, inboxFrom, nameOf, record, rowsFrom, slashCommand, text, unwrap, type Attachment, type ChatTarget, type Project, type CompiledSubmission } from './model';
import { admitNativeNewSessionFolder, nativeNewSessionFolderFrom, type NativeNewSessionFolderTarget, type NativeNewSessionFolderReceipt, type NativeNewSessionFolderAdmission } from './new-session-folder';
export type { NativeNewSessionFolderTarget, NativeNewSessionFolderAdmission } from './new-session-folder';

export { desktopGitDraftAuthority };

export type NativeNewSessionSelection = { model?: { providerID: string; id: string; variant?: string }; agent?: string };
type Receipt = { version: 1; revision: number; selection: NativeNewSessionSelection; folder?: NativeNewSessionFolderReceipt; admission?: 'preparing' | 'unknown' | 'acknowledged'; configuration?: { model?: 'unknown' | 'acknowledged'; agent?: 'unknown' | 'acknowledged' } } & (
  | { phase: 'draft' }
  | { phase: 'creating'; inputID: string }
  | { phase: 'created' | 'installed'; inputID: string; target: ChatTarget }
);
type Lane = { tail: Promise<unknown>; owner: number };
const lanes = new Map<string, Lane>();
let nextOwner = 0;
const localTarget = (directory: string): ChatTarget => ({ kind: 'session', id: 'new-session-draft', title: '', directory });
const receiptKey = (hostID: string, directory: string, authorityKey?: string) => `nsh:new-session:v1:${encodeURIComponent(JSON.stringify([hostID, directory, ...(authorityKey === undefined ? [] : [authorityKey])]))}`;

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
  if (row.admission !== undefined && row.admission !== 'preparing' && row.admission !== 'unknown' && row.admission !== 'acknowledged') throw new Error('new-session-invalid-receipt');
  const configuration = record(row.configuration);
  if (row.configuration !== undefined && (!row.configuration || typeof row.configuration !== 'object' || Array.isArray(row.configuration) || Object.keys(configuration).some(key => !['model', 'agent'].includes(key)) || Object.values(configuration).some(value => value !== 'unknown' && value !== 'acknowledged'))) throw new Error('new-session-invalid-receipt');
  const folder = nativeNewSessionFolderFrom(row.folder);
  const base = { version: 1 as const, revision: Number(row.revision), selection: selectionFrom(row.selection), ...(folder ? { folder } : {}),
    ...(row.admission ? { admission: row.admission as Receipt['admission'] } : {}),
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

export type NativeNewSessionHandoff = { target: ChatTarget; hostID: string; generation: number; inputID: string; draftAuthorityKey?: string };
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
  if (handoff.target.kind !== 'session' || chat.referenceScope.draft !== draftKey(handoff.hostID, handoff.target, handoff.draftAuthorityKey) || chat.referenceScope.directory !== handoff.target.directory) throw new Error('new-session-handoff-scope-mismatch');
  if (chat.pendingSend() && chat.pendingSend()!.id !== handoff.inputID) throw new Error('new-session-handoff-input-mismatch');
  // Share createChat's startup recovery flight. It may have admitted/cleared the
  // durable input before this navigation callback gets its first turn.
  if (await chat.recoverPendingSend()) return current();
  if (!current()) return false;
  let pending = chat.pendingSend();
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
  if (pending.command?.name.toLowerCase() === 'compact' && pending.inputMode !== 'shell' && !pending.references?.references.length && !pending.localMagic && !pending.localCompact) {
    const original = pending;
    const [payload, skillPayload] = await Promise.all([
      request(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(handoff.target.directory)}`),
      request(referenceRoute('skill', handoff.target.directory, '')),
    ]);
    if (!current() || chat.pendingSend() !== original) return false;
    const commands = Array.isArray(payload) ? payload : record(payload).data;
    const skills = Array.isArray(skillPayload) ? skillPayload : record(skillPayload).data;
    if (!Array.isArray(commands) || !Array.isArray(skills)) throw new Error('Invalid command catalog');
    const skill = skills.map(record).find(item => text(item.name).toLowerCase() === 'compact');
    if (skill && !text(skill.id)) throw new Error('Invalid skill catalog');
    const registered = commands.map(record).find(item => text(item.name).toLowerCase() === 'compact');
    if (skill || !registered || registered.isBuiltIn === false) {
      const suffix = original.command?.text ? ` ${original.command.text}` : '';
      const compiledText = skill ? `[skill:${text(skill.id)}]${suffix}` : registered ? `[command:${text(registered.reference) || text(registered.name)}]${suffix}` : original.preparedText ?? original.text;
      pending = { ...original, command: undefined, compiled: { text: compiledText, ...(skill ? { skills: [{ id: text(skill.id) }] } : {}) } };
      chat.pendingSend.set(pending);
      await chat.flushDraft();
      if (!current() || chat.pendingSend() !== pending) return false;
    }
  }
  const prepare = options.prepare ?? (pending.inputMode !== 'shell' && (magicCommand(pending.text) || pending.references?.references.length) ? (input: Parameters<typeof compileNativePrompt>[0]) => {
    if (!request) throw new Error('new-session-request-owner-required');
    return compileNativePrompt(input, request);
  } : undefined);
  if (pending.localMagic) return (await chat.dispatchLocalMagicHandoff(handoff.inputID)).status === 'accepted' && current();
  const admitted = await chat.retrySend({ ...options, ...(prepare ? { prepare } : {}) });
  return admitted === true && current();
}

/** Headless draft owner. Opening/typing/selecting never creates a remote session. */
export function openNativeNewSession(options: { project?: Project; directory?: string; active: () => boolean; operation?: () => PageOperation | null; draftAuthorityKey?: string; folder?: NativeNewSessionFolderTarget; folderAdmission?: NativeNewSessionFolderAdmission; desktopWriter?: NewSessionWriterAdmission; deviceChatPreferences?: () => { persistChatDraft: boolean } | null }) {
  const lifetime = createPageOperations();
  const operation = signal<PageOperation | null>(null);
  const connection = app.connection();
  if (!connection) throw new Error('new-session-no-host');
  const draftConnection = { id: connection.id, url: connection.url, authorizationID: connection.authorizationID };
  const hostID = connection.id;
  const draftAuthorityValid = options.draftAuthorityKey === undefined || desktopGitDraftAuthority(connection) === options.draftAuthorityKey;
  const generation = epoch(), directory = options.directory ?? options.project?.path ?? '';
  const project: Project = { id: options.project?.id ?? '', name: options.project?.name ?? nameOf(directory), path: directory };
  const writerRevision = signal(0);
  if (platform?.desktop && !options.desktopWriter) throw new Error('new-session-writer-required');
  const writer = platform?.desktop ? createNewSessionWriterCustody(options.desktopWriter!, {
    directory, scope: app.runtimeScope(), current: () => ownedScope(), hostCurrent: () => hostCurrent(), changed: () => writerRevision.set(untracked(writerRevision) + 1),
  }) : undefined;
  const draftOptions = options.draftAuthorityKey !== undefined ? options.draftAuthorityKey : options.deviceChatPreferences ? { persistChatDraft: () => options.deviceChatPreferences!()?.persistChatDraft ?? null } : {};
  const durable = openDraft(hostID, localTarget(directory), draftOptions), key = receiptKey(hostID, directory, options.draftAuthorityKey), owner = ++nextOwner;
  const lane = lanes.get(key) ?? { tail: Promise.resolve(), owner };
  lane.owner = owner; lanes.set(key, lane);
  const receipt = signal<Receipt>({ version: 1, revision: 0, phase: 'draft', selection: {} });
  const status = signal<'loading' | 'ready' | 'error'>('loading'), error = signal(''), submitting = signal(false);
  const folderChanging = signal(false);
  let alive = true, hydrated = false, snapshotRevision = 0, restoredRemote = false;
  const knownCreated = signal<ChatTarget | null>(null);
  let submitFlight: Promise<NativeNewSessionHandoff | null> | undefined;
  let submitOperation: PageOperation | null = null;
  let firstOperation: PageOperation | null = null;
  let retired = false, externalOperation = false, closing = false, admissionWriteUnknown = false;
  let retirementIntent = 0, retirementRevision: number | undefined;
  let writerReleaseFlight: Promise<boolean> | undefined;
  let closeFlight: Promise<void> | undefined;
  const retirementGuards = new Set<() => boolean>();
  const businessSettled = () => [...retirementGuards].every(guard => { try { return guard(); } catch { return false; } });
  function bindRetirementGuard(guard: () => boolean) {
    retirementGuards.add(guard);
    // Unknown attachment/selection work remains protected after its view leaves.
    return () => { try { if (guard()) retirementGuards.delete(guard); } catch { /* An unreadable guard stays protective. */ } };
  }
  function setClosing(value: boolean) { closing = value; writerRevision.set(untracked(writerRevision) + 1); }
  const ownsJournal = () => alive && lane.owner === owner;
  function hostCurrent() {
    const next = app.connection();
    if (next?.id !== draftConnection.id || next?.url !== draftConnection.url || next?.authorizationID !== draftConnection.authorizationID || !draftAuthorityValid) retired = true;
    return !retired;
  }
  const ownedScope = () => ownsJournal() && hostCurrent();
  const current = () => { writerRevision(); return !closing && ownedScope() && operation()?.current() === true && options.active() && (!writer || writer.current(operation()?.scope ?? null)); };
  function assignOperation(next: PageOperation | null) {
    if (!ownedScope() || next && (!next.current() || next.scope?.hostID && next.scope.hostID !== hostID)) { operation.set(null); return false; }
    if (operation() === next) return true;
    operation.set(next);
    if (writer && next?.scope) void writer.renew(next.scope).catch(() => {});
    return true;
  }
  function replaceOperation(next: PageOperation | null) { externalOperation = true; return assignOperation(next); }
  effect(() => { app.connection(); const next = options.operation ? options.operation() : lifetime.operation(); untracked(() => { ownedScope(); if (!externalOperation) assignOperation(next); }); });
  function captureOperation(requireActive = true) {
    const assigned = operation();
    const current = () => !closing && ownedScope() && operation() === assigned && assigned?.current() === true && (!requireActive || options.active())
      && (!writer || !!writer.source.grant());
    if (!assigned || !current()) throw new Error('new-session-scope-changed');
    const send = writer ? bindRequest(assigned.scope, writer.source.grant) : assigned.request;
    return Object.freeze({ ...assigned, current, request: async (path: string, method = 'GET', body?: unknown) => {
      if (!current()) throw new Error('new-session-scope-changed');
      try { return await send(path, method, body); }
      catch (failure) { if (!current()) throw new Error('new-session-scope-changed'); throw failure; }
    } });
  }
  const assertCurrent = (captured: Pick<PageOperation, 'current'>) => { if (!captured.current()) throw new Error('new-session-scope-changed'); };
  function enqueue<T>(work: () => Promise<T>) {
    const flight = lane.tail.catch(() => {}).then(work); lane.tail = flight; return flight;
  }
  const restore = () => enqueue(async () => {
    try {
      let saved = receiptFrom(await Storage.getItem(key), directory);
      if (!ownsJournal()) throw new Error('new-session-source-retired');
      if (options.folder) {
        const folder = nativeNewSessionFolderFrom({ scope: options.folder.scope, id: options.folder.id })!;
        const changed = !saved.folder || saved.folder.scope !== folder.scope || saved.folder.id !== folder.id;
        if (changed && saved.phase !== 'draft') throw new Error('new-session-folder-conflict');
        if (changed) {
          saved = { ...saved, folder, revision: saved.revision + 1 };
          await Storage.setItem(key, JSON.stringify(saved));
        }
      }
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
    if (receipt().phase !== 'draft' || submitting() || folderChanging()) throw new Error('new-session-selection-frozen');
    await write({ ...receipt(), selection: selectionFrom(selection) }, captured);
  }
  /** Explicit folder-tree intent may retarget the existing unsent owner, never a created receipt. */
  async function setFolder(target: NativeNewSessionFolderTarget) {
    if (folderChanging() || submitting() || submitFlight) throw new Error('new-session-folder-frozen');
    const captured = captureOperation();
    folderChanging.set(true);
    try {
      await restoration; assertCurrent(captured);
      if (receipt().phase !== 'draft' || submitting() || durable.pendingSend()) throw new Error('new-session-folder-frozen');
      const folder = nativeNewSessionFolderFrom({ scope: target.scope, id: target.id })!;
      if (receipt().folder?.scope === folder.scope && receipt().folder?.id === folder.id) return;
      await write({ ...receipt(), folder }, captured);
    } finally { folderChanging.set(false); }
  }
  const setDraftText = (value: string) => { if (!current()) return false; durable.setDraftText(value); return true; };
  function compareAndSetDraftText(revision: number, value: string) {
    if (!current() || !Number.isSafeInteger(revision) || typeof value !== 'string' || durable.revision() !== revision) return false;
    return setDraftText(value);
  }
  const setAttachments = (value: Attachment[]) => { if (!current()) return false; durable.attachments.set(value.map(file => ({ ...file }))); return true; };
  const insertReference = (...args: Parameters<typeof durable.insertReference>) => { if (!current()) return false; durable.insertReference(...args); return true; };
  function stageContext(input: DesktopGitContextInput, confirmation?: DesktopGitStageConfirmation): Promise<DesktopGitStageResult> {
    const captured = operation(), lease = input.lease;
    return durable.stageContext(input, () => operation() === captured && captured?.scope?.lease === lease && current() && receipt().phase === 'draft' && !submitting() && !folderChanging(), confirmation);
  }
  const clearContext = () => { if (!current()) return false; durable.context.set(undefined); return true; };
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
  type LocalCreation = { submission: ContextSubmission; current: () => boolean; dispatched: boolean; rejected?: boolean };
  async function admitLocalMagic(compiled: CompiledSubmission, invocation: NativeLocalCommandInvocation): Promise<NativeLocalCommandOutcome & { handoff?: NativeNewSessionHandoff }> {
    const snapshot = invocation.snapshot, assigned = operation();
    if (!current() || !invocation.current() || status() !== 'ready' || durable.status() !== 'ready' || receipt().phase !== 'draft' || submitting() || folderChanging() || submitFlight || durable.pendingSend() || durable.queueEdit() || snapshot.target.kind !== 'draft' || snapshot.target.directory !== directory || snapshot.revision !== durable.revision() || snapshot.text !== durable.draft() || invocation.command === 'summary') return { status: 'rejected' };
    const tokenEnd = /^\s*\/\u2003?[^\s]+/.exec(snapshot.text)?.[0].length ?? 0;
    if (durable.references().some(ref => ref.start < tokenEnd && ref.end > snapshot.text.indexOf('/'))) return { status: 'rejected' };
    let local: LocalCreation | undefined;
    try {
      const submission = { ...localMagicSubmission(compiled, invocation, durable.scope), id: id() };
      const selection = receipt().selection, capturedSelection = submission.localMagic!.selection;
      if (selection.agent !== capturedSelection.agent || selection.model?.providerID !== capturedSelection.model?.providerID || selection.model?.id !== capturedSelection.model?.modelID || selection.model?.variant !== capturedSelection.model?.variant) return { status: 'rejected' };
      const selectionRevision = receipt().revision;
      local = { submission, dispatched: false, current: () => current() && operation() === assigned && invocation.current() && (receipt().phase !== 'draft' || receipt().revision === selectionRevision) };
      const handoff = await submitInternal({}, local);
      return handoff ? { status: 'accepted', handoff } : { status: 'rejected' };
    } catch { return { status: local?.dispatched && !local.rejected ? 'unknown' : 'rejected' }; }
  }
  const submit = (sendOptions: Pick<SendOptions, 'inputMode'> & { presetText?: string } = {}) => submitInternal(sendOptions);
  function submitInternal(sendOptions: Pick<SendOptions, 'inputMode'> & { presetText?: string } = {}, local?: LocalCreation): Promise<NativeNewSessionHandoff | null> {
    if (folderChanging()) return Promise.resolve(null);
    if (submitFlight) return submitFlight;
    let captured: ReturnType<typeof captureOperation>;
    try { captured = captureOperation(); } catch (failure) { return Promise.reject(failure); }
    const assigned = operation()!;
    firstOperation ??= assigned;
    submitOperation = assigned;
    const flight = (async () => {
      submitting.set(true); error.set('');
      let localRevision = durable.revision();
      const assertLocal = () => { if (local && (!local.current() || durable.revision() !== localRevision)) throw new Error('local-magic-stale'); };
      try {
        await restoration; assertCurrent(captured);
        assertLocal();
        if (!directory) throw new Error('new-session-directory-required');
        let value = receipt();
        if (value.phase === 'draft') { firstOperation = assigned; restoredRemote = false; }
        const readOnly = value.phase !== 'draft' && (firstOperation !== assigned || restoredRemote);
        if (value.phase === 'draft') {
          if (!durable.draft().trim() && !durable.attachments().length) return null;
          if (durable.queueEdit()) throw new Error('new-session-queue-edit-blocked');
          let submission = durable.pendingSend();
          if (submission?.localMagic && !local) throw new Error('local-magic-handoff-required');
          if (!submission) {
            const document = untracked(durable.document), mode = sendOptions.inputMode ?? 'normal';
            if (mode === 'shell' && (document.references.length || durable.attachments().length || durable.context())) throw new Error('new-session-shell-references-unsupported');
            const capturedText = sendOptions.presetText ?? document.text;
            submission = local?.submission ?? { id: id(), text: document.text, files: durable.attachments().map(file => ({ ...file })), delivery: 'steer', uncertain: false, inputMode: mode, references: relocate(document, durable.scope), ...(durable.context() ? { context: durable.context() } : {}), ...(sendOptions.presetText !== undefined ? { preparedText: sendOptions.presetText } : {}) };
            if (!local && mode !== 'shell' && !submission.context && !document.references.length && !magicCommand(document.text)) {
              const command = slashCommand(capturedText.replace(/^(\s*)\/\u2003/, '$1/')); if (command) submission.command = command;
            }
            snapshotRevision = durable.draftRevision();
            durable.pendingSend.set(submission);
            localRevision = durable.revision();
          }
          // Persist exact text/sidecars/files before the create write-ahead record.
          await durable.flush(); assertCurrent(captured);
          assertLocal();
          if (submission.context && !submission.compiled) {
            if (!options.draftAuthorityKey) throw new Error('git-context-scope-mismatch');
            const context = submission.context;
            const compiled = await compileNativePrompt({ text: submission.text, files: submission.files, references: submission.references, scope: durable.scope, isCurrentScope: captured.current }, captured.request);
            assertCurrent(captured);
            submission = { ...submission, compiled: compileDesktopGitContext(compiled, context) };
            submission.preparedText = submission.compiled!.text;
            durable.pendingSend.set(submission);
            await durable.flush(); assertCurrent(captured);
          }
          value = await write({ ...value, phase: 'creating', inputID: submission.id }, captured);
          assertCurrent(captured);
          assertLocal();
          knownCreated.set(null);
          if (local) local.dispatched = true;
          let response: ReturnType<typeof record>;
          try { response = record(unwrap(await captured.request('/api/session', 'POST', { location: { directory: project.path } }))); }
          catch (failure) {
            const code = record(failure).status;
            if (local && typeof code === 'number' && code >= 400 && code < 500 && code !== 408 && code !== 429) local.rejected = true;
            throw failure;
          }
          if (!text(response.id) || writer && (text(response.id).trim() !== response.id || /[\x00-\x1f\x7f]/.test(text(response.id)) || (text(record(response.location).directory) || text(response.directory)) !== directory
            || response.directory !== undefined && response.directory !== directory || record(response.location).directory !== undefined && record(response.location).directory !== directory)) {
            writer?.source.markUnknown(new Error('new-session-invalid-create-receipt'));
            throw new Error('new-session-invalid-create-receipt');
          }
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
        const sessionWriter = writer ? await writer.ensureSession(value.target.id, captured) : undefined;
        assertCurrent(captured);
        const sessionOperation: PageOperation = sessionWriter ? Object.freeze({ ...captured, request: async (path: string, method = 'GET', body?: unknown) => {
          assertCurrent(captured);
          const result = await bindRequest(captured.scope, sessionWriter.grant)(path, method, body);
          assertCurrent(captured); return result;
        } }) : captured;
        if (value.folder && value.folder.status !== 'acknowledged') {
          const target = value.target;
          await (options.folderAdmission ?? admitNativeNewSessionFolder)({ folder: value.folder, target, operation: captured, note: async status => {
            const latest = receipt();
            if (!latest.folder || latest.phase !== 'created' && latest.phase !== 'installed' || latest.target.id !== target.id) throw new Error('new-session-folder-conflict');
            await write({ ...latest, folder: { ...latest.folder, status } }, captured, status === 'acknowledged');
          } });
          assertCurrent(captured); value = receipt();
          if (!value.folder || value.folder.status !== 'acknowledged') throw new Error('new-session-folder-not-confirmed');
        }
        if (value.phase === 'created') {
          const submission = durable.pendingSend();
          if (!submission || submission.id !== value.inputID || !submission.references) throw new Error('new-session-snapshot-missing');
          await configure(value.target, value.selection, sessionOperation, readOnly); assertCurrent(captured);
          const destination = openDraft(hostID, value.target, draftOptions);
          try {
            await destination.ready; assertCurrent(captured);
            const references = submission.localMagic ? { text: '', references: [], scope: { ...destination.scope } } : relocate(submission.references, destination.scope);
            const transferred: ContextSubmission = { ...submission, files: submission.files.map(file => ({ ...file })), references };
            const pending = destination.pendingSend();
            const referenceIdentity = (document: ScopedReferenceDocument | undefined) => document && JSON.stringify([document.text, document.scope.host, document.scope.draft, document.scope.directory, document.references.map(ref => [ref.kind, ref.value, ref.label, ref.display, ref.start, ref.end, ref.directory, ref.description])]);
            const staged = pending?.id === value.inputID && pending.text === transferred.text && pending.delivery === transferred.delivery && pending.inputMode === transferred.inputMode && pending.command?.name === transferred.command?.name && pending.command?.text === transferred.command?.text && pending.preparedText === transferred.preparedText && pending.files.length === transferred.files.length && pending.files.every((file, index) => sameAttachment(file, transferred.files[index])) && referenceIdentity(pending.references) === referenceIdentity(references) && !destination.queueEdit() && sameDesktopGitContext(destination.context(), submission.context) && sameDesktopGitContext(pending?.context, submission.context);
            if (!staged) {
              if (destination.pendingSend() || destination.queueEdit() || destination.draft() || destination.attachments().length || destination.context()) throw new Error('new-session-destination-not-empty');
              destination.setDocument(references); destination.attachments.set(transferred.files); destination.context.set(transferred.context); destination.pendingSend.set(transferred);
            }
            await destination.flush(); assertCurrent(captured);
            value = await write({ ...receipt(), phase: 'installed', target: value.target, inputID: value.inputID }, captured);
          } finally { await destination.close(); }
        }
        assertCurrent(captured);
        if (value.phase !== 'installed') throw new Error('new-session-invalid-receipt');
        status.set('ready');
        return { target: { ...value.target }, hostID, generation, inputID: value.inputID, ...(options.draftAuthorityKey === undefined ? {} : { draftAuthorityKey: options.draftAuthorityKey }) };
      } catch (failure) {
        if (local && (!local.dispatched || local.rejected) && ownsJournal() && (!writer || !!writer.source.grant())) {
          if (receipt().phase === 'creating') await write({ version: 1, revision: receipt().revision, phase: 'draft', selection: receipt().selection, ...(receipt().folder ? { folder: receipt().folder } : {}) }, captured, true).catch(() => {});
          if (durable.pendingSend()?.id === local.submission.id) { durable.pendingSend.set(null); await durable.flush().catch(() => {}); }
        }
        if (captured.current() || writer && ownedScope()) { status.set('error'); error.set(local ? 'new-session-submit-failed' : failure instanceof Error ? failure.message : 'new-session-submit-failed'); }
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
    if (value.folder && value.folder.status !== 'acknowledged') throw new Error('new-session-folder-not-confirmed');
    if (value.phase !== 'installed' || value.inputID !== handoff.inputID || value.target.id !== handoff.target.id || value.target.directory !== handoff.target.directory || handoff.target.kind !== 'session' || handoff.hostID !== hostID || handoff.generation !== generation) throw new Error('new-session-handoff-input-mismatch');
    if (captured && !captured.localMagic) {
      if (durable.draftRevision() === snapshotRevision && durable.matchesDocument(captured.text, captured.references?.references)) durable.setDocument({ text: '', references: [], scope: durable.scope });
      durable.attachments.set(durable.attachments().filter(file => !captured.files.some(sent => sameAttachment(file, sent))));
      if (captured.context && sameDesktopGitContext(durable.context(), captured.context)) durable.context.set(undefined);
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
  const retirementAllowed = () => businessSettled() && receipt().phase === 'draft' && !durable.pendingSend() && !durable.queueEdit() && !folderChanging() && !submitting()
    && durable.status() === 'ready' && status() !== 'loading';
  const retirementPrepared = () => closing && ownedScope() && retirementRevision === durable.revision() && retirementAllowed();
  const canReleaseWriter = () => retirementPrepared() && (!writer || !!writer.source.grant() && sameRuntimeScope(writer.source.expectedHost, app.runtimeScope()) && writer.source.canRelease());
  function cancelWriterRetirement() { retirementIntent++; retirementRevision = undefined; setClosing(false); }
  async function prepareWriterRetirement() {
    const intent = ++retirementIntent;
    retirementRevision = undefined; setClosing(true);
    try {
      await submitFlight?.catch(() => {});
      await durable.flush();
      if (writer) await lane.tail;
      if (intent !== retirementIntent || !ownedScope() || !retirementAllowed()) throw new Error('new-session-writer-release-blocked');
      retirementRevision = durable.revision();
      if (!canReleaseWriter()) throw new Error('new-session-writer-release-blocked');
      return true;
    } catch {
      if (intent === retirementIntent) cancelWriterRetirement();
      return false;
    }
  }
  function releaseWriter(): Promise<boolean> {
    if (writer?.source.phase() === 'released') return Promise.resolve(true);
    if (writerReleaseFlight) return writerReleaseFlight;
    if (!canReleaseWriter()) return Promise.resolve(false);
    const flight = writer ? writer.releaseSource(retirementPrepared) : Promise.resolve(true);
    writerReleaseFlight = flight;
    void flight.then(released => {
      if (!released && !writer?.source.status().unknown && writerReleaseFlight === flight) writerReleaseFlight = undefined;
    });
    return flight;
  }
  function close(): Promise<void> {
    if (closeFlight) return closeFlight;
    closeFlight = (async () => {
      try {
        if (writer) {
          if (writer.source.phase() !== 'released' && (!await prepareWriterRetirement() || !await releaseWriter())) throw new Error('new-session-writer-release-blocked');
        } else {
          setClosing(true);
          await submitFlight?.catch(() => {});
          await durable.flush();
        }
        await durable.close();
        alive = false;
        if (lane.owner === owner && !submitFlight) lanes.delete(key);
      } catch (failure) { cancelWriterRetirement(); throw failure; }
    })();
    const flight = closeFlight;
    void flight.catch(() => { if (closeFlight === flight) closeFlight = undefined; });
    return flight;
  }
  async function noteAdmission(handoff: NativeNewSessionHandoff, phase: 'preparing' | 'unknown' | 'acknowledged', captured: PageOperation) {
    await restoration; assertCurrent(captured);
    if (admissionWriteUnknown) throw new Error('new-session-admission-storage-unknown');
    const value = receipt();
    if (value.phase !== 'installed' || value.inputID !== handoff.inputID || value.target.id !== handoff.target.id || handoff.hostID !== hostID || handoff.generation !== generation || handoff.target.directory !== directory) throw new Error('new-session-handoff-input-mismatch');
    if (value.folder && value.folder.status !== 'acknowledged') throw new Error('new-session-folder-not-confirmed');
    if (value.admission === 'acknowledged' || value.admission === phase) return;
    try { await write({ ...value, admission: phase }, captured); }
    catch (failure) { if (captured.current()) admissionWriteUnknown = true; throw failure; }
  }
  return { directory, hostID, generation, project: { ...project }, durable, ready, status, error, submitting, folderChanging, current, replaceOperation, captureOperation, operation, ownedScope, noteAdmission, admission: () => admissionWriteUnknown ? 'unknown' as const : receipt().admission,
    selection: () => selectionFrom(receipt().selection),
    folder: () => receipt().folder ? { ...receipt().folder! } : undefined,
    phase: () => receipt().phase, target: () => { const value = receipt(); return value.phase === 'created' || value.phase === 'installed' ? { ...value.target } : null; },
    creationUnknown: () => receipt().phase === 'creating' && !knownCreated(), inputID: () => { const value = receipt(); return value.phase === 'draft' ? durable.pendingSend()?.id : value.inputID; },
    stageContext, context: () => durable.context(), clearContext, draftAuthorityKey: options.draftAuthorityKey,
    composerRevision: durable.revision, compareAndSetDraftText, admitLocalMagic,
    desktopWriter: () => writer?.session(), sourceWriter: () => writer?.source, transferWriter: () => writer?.transfer(), reclaimWriter: () => writer?.reclaim(), bindRetirementGuard,
    prepareWriterRetirement, canReleaseWriter, cancelWriterRetirement, releaseWriter,
    setDraftText, setAttachments, insertReference, select, setFolder, submit, complete, retryStorage, recoverCreatedSession, close };
}

export type NativeNewSessionOwner = ReturnType<typeof openNativeNewSession>;
export type NativeNewSessionPageHandoff = { receipt: NativeNewSessionHandoff; owner: NativeNewSessionOwner; desktopWriter?: DesktopWriterClaim; release: () => Promise<void>; released: () => boolean };

/** Page cleanup and navigation handoff have separate, explicit ownership. */
export function createNativeNewSessionOwnership(options: Parameters<typeof openNativeNewSession>[0]) {
  const transferred = signal(false), released = signal(false);
  let attached = true, releaseFlight: Promise<void> | undefined, handoff: NativeNewSessionPageHandoff | undefined;
  const owner = openNativeNewSession({ ...options, active: () => attached && !transferred() && options.active() });
  function release() {
    if (!releaseFlight) {
      releaseFlight = owner.close().then(() => { released.set(true); });
      void releaseFlight.catch(() => { releaseFlight = undefined; });
    }
    return releaseFlight;
  }
  function transfer(receipt: NativeNewSessionHandoff): NativeNewSessionPageHandoff {
    if (handoff) {
      if (handoff.receipt.inputID !== receipt.inputID || released()) throw new Error('new-session-handoff-input-mismatch');
      return handoff;
    }
    if (!owner.current() || owner.phase() !== 'installed' || owner.inputID() !== receipt.inputID || owner.hostID !== receipt.hostID || owner.generation !== receipt.generation || owner.target()?.id !== receipt.target.id || owner.directory !== receipt.target.directory || owner.folder() && owner.folder()?.status !== 'acknowledged') throw new Error('new-session-handoff-scope-mismatch');
    transferred.set(true);
    const desktopWriter = owner.transferWriter();
    if (platform?.desktop && !desktopWriter?.grant()) { transferred.set(false); throw new Error('new-session-writer-required'); }
    handoff = { receipt, owner, ...(desktopWriter ? { desktopWriter } : {}), release, released };
    return handoff;
  }
  function reclaim(value: NativeNewSessionPageHandoff) {
    if (!attached || handoff !== value || released()) return false;
    handoff = undefined; transferred.set(false); owner.reclaimWriter(); return true;
  }
  function disposePage() {
    if (transferred()) { attached = false; return Promise.resolve(); }
    return release().then(() => { attached = false; });
  }
  return { owner, transfer, reclaim, disposePage, transferred, released, handoff: () => handoff };
}
