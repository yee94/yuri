import { cleanup, Clipboard, computed, effect, lifecycle, signal, Storage, Text, View, type Signal } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { t } from './i18n';
import { record, type Attachment, type ChatTarget, type Message } from './model';
import { query, type request } from './runtime';
import { captureHostRequest } from './state';
import type { PageOperation } from './page-operations';
import { Icon } from './Icon';
import { NativeTurnMetrics } from './transcript-tools-turn';
import { NativeUserTimestamp } from './transcript-time';
import { createTranscriptActions, nativeRevertFrom, type NativeEditDraft, type NativeRevert, type TranscriptScope } from './transcript-actions-core';
import { historyDraftBackupFrom, historyDraftBackupJSON, historyDraftSnapshot, replaceHistoryDraft, type HistoryDraftSnapshot } from './transcript-actions-backup';
import type { ReferenceScope, ScopedReferenceDocument } from './composer-references';
import { NativeSpeechAction, type NativeSpeech } from './speech';
import { nativeAppearance } from './appearance';
import { nativeAssistantTps } from './chat-preferences-core';

export type NativeMessageActionOptions = {
  send: typeof request;
  target: ChatTarget;
  message: () => Message;
  scope: TranscriptScope;
  onEditDraft?: (draft: NativeEditDraft) => void | Promise<void>;
  canEditDraft?: () => boolean;
  onPending?: (pending: boolean) => void;
  onUncertain?: () => void;
  onOpenChat?: (target: ChatTarget) => void;
  onRevert?: (revert: NativeRevert | null) => void;
  onChanged?: () => void | Promise<void>;
  onError?: (failure: unknown) => void;
  revert?: () => NativeRevert | null;
  tps?: string;
  duration?: string;
};
const action = 'min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';
const iconAction = 'h-6 w-6 items-center justify-center rounded-lg active:bg-accent disabled:opacity-40';

/** Keep mounted with the chat (not inside the hidden reverted tail) to retain redo. */
export function NativeMessageActions(props: { history: ReturnType<typeof createNativeTranscriptHistory>; message: () => Message; tps?: string; duration?: string; speech?: NativeSpeech }) {
  const binding = computed(() => {
    const options = props.history.props(props.message);
    return { options, scope: options.scope, actions: createTranscriptActions(options) };
  });
  const options = () => binding().options;
  const message = () => props.message();
  const pending = signal(false), error = signal(''), copied = signal(false);
  let alive = true;
  cleanup(() => { alive = false; });
  // Virtualization/revert may remove this row while the page-owned operation settles.
  const disabled = () => pending() || !binding().actions.current() || binding().actions.pending();
  effect(() => { binding(); pending.set(false); });
  effect(() => { message().id; copied.set(false); error.set(''); });
  async function perform(work: (captured: ReturnType<typeof binding>) => Promise<void>, captured = binding()) {
    if (disabled()) return;
    if (!captured.scope.current()) return;
    pending.set(true); error.set('');
    try { await work(captured); }
    catch (failure) { if (captured.scope.current()) { captured.options.onError(failure); if (alive) error.set(failure instanceof Error ? failure.message : t('miniChat.actions.failed')); } }
    finally { if (alive && captured === binding()) pending.set(false); }
  }
  async function confirmRevert() {
    const captured = binding();
    const selectedID = message().id;
    const result = await AlertDialog.show({ title: t('chat.messageBody.actions.revert'), description: t('chat.revertPopover.files'), actions: [
      { id: 'revert', label: t('chat.revertPopover.revert'), role: 'destructive' },
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
    ] });
    if (captured.scope.current() && message().id === selectedID && message().role === 'user' && result.action === 'revert') await perform(() => captured.actions.revert(true), captured);
  }
  return <View class="gap-2">
    <View testID={`history-actions-${message().id}-${message().role}`} class={message().role === 'user' ? 'flex-row justify-end gap-2' : 'flex-row items-center gap-2'}>
      <If when={message().role === 'user' && !!message().time?.created}><NativeUserTimestamp created={message().time!.created!} /></If>
      <If when={message().role !== 'user' && !!(message().text || message().error)}>
        <Button testID={`history-copy-${message().id}`} class={iconAction} hitSlop={10} accessibilityLabel={copied() ? t('chat.messageBody.shellCommand.copied') : t('chat.messageBody.actions.copyMessage')} disabled={disabled()} onPress={() => { void perform(async captured => { await Clipboard.writeText(message().text || message().error); if (captured.scope.current()) copied.set(true); }); }}><Icon name={copied() ? 'check' : 'file-copy'} size={16} /></Button>
      </If>
      <If when={message().role !== 'user' && !!props.speech}><NativeSpeechAction speech={props.speech!} messageID={message().id} text={message().text} /></If>
      <If when={options().target.kind === 'session'}>
        <If when={message().role === 'user'}>
          <Button testID={`history-revert-${message().id}`} class={iconAction} hitSlop={10} accessibilityLabel={t('chat.messageBody.actions.revert')} disabled={disabled() || options().scope.busy()} onPress={() => { void confirmRevert(); }}><Icon name="arrow-go-back" size={16} /></Button>
        </If>
        <If when={message().role === 'user' && !!options().onEditDraft}>
          <Button testID={`history-edit-${message().id}`} class={iconAction} hitSlop={10} accessibilityLabel={t('chat.messageBody.actions.edit')} disabled={disabled() || options().scope.busy() || options().canEditDraft?.() === false} onPress={() => { void perform(captured => captured.actions.edit()); }}><Icon name="edit" size={16} /></Button>
        </If>
        <If when={!!options().onOpenChat}>
          <Button testID={`history-fork-${message().id}`} class={iconAction} hitSlop={10} accessibilityLabel={t('chat.messageBody.actions.fork')} disabled={disabled()} onPress={() => { void perform(captured => captured.actions.fork()); }}><Icon name="git-branch" size={16} /></Button>
        </If>
      </If>
      <If when={message().role === 'user' && !!(message().text || message().error)}>
        <Button testID={`history-copy-${message().id}`} class={iconAction} hitSlop={10} accessibilityLabel={copied() ? t('chat.messageBody.shellCommand.copied') : t('chat.messageBody.actions.copyMessage')} disabled={disabled()} onPress={() => { void perform(async captured => { await Clipboard.writeText(message().text || message().error); if (captured.scope.current()) copied.set(true); }); }}><Icon name={copied() ? 'check' : 'file-copy'} size={16} /></Button>
      </If>
      <If when={message().role !== 'user'}><NativeTurnMetrics tps={nativeAssistantTps(props.tps, nativeAppearance.current()?.showAssistantTps)} duration={props.duration} /></If>
    </View>
    <If when={!!error()}><Text class="text-sm text-destructive">{error()}</Text></If>
  </View>;
}

type HistoryChat = {
  draft: Signal<string>; attachments: Signal<Attachment[]>;
  messages: () => Message[]; active: () => boolean; busy: () => boolean; sending: () => boolean;
  pendingSend: () => unknown; queueEdit: () => unknown; draftStatus: () => string;
  load: () => Promise<void>;
  /** Owned/synchronized by createChat when available. */
  revert?: Signal<NativeRevert | null>;
  historyBusy?: Signal<boolean>;
  referenceDocument: () => ScopedReferenceDocument;
  referenceScope: ReferenceScope;
  setReferenceDocument: (next: ScopedReferenceDocument, expected?: ScopedReferenceDocument) => boolean;
  flushDraft: () => Promise<void>;
  refreshHistory?: (valid?: () => boolean) => Promise<NativeRevert | null>;
  readonly messageScope?: { generation: number };
};

/** Page-owned recovery survives row removal/virtualization, never owns server history. */
export function createNativeTranscriptHistory(input: { chat: HistoryChat; target: ChatTarget; current: () => boolean; key: string; storageKey: string; onOpenChat: (target: ChatTarget) => void; operation?: () => PageOperation | null }) {
  const initialRequest = captureHostRequest();
  const { chat, target } = input;
  const revert = chat.revert ?? signal<NativeRevert | null>(null);
  const saved = signal<HistoryDraftSnapshot[]>([]);
  const error = signal(''), pending = signal(false);
  const uncertain = signal(false);
  const ready = signal(false);
  let alive = true;
  const current = () => alive && input.current() && chat.active() && lifecycle() === 'active';
  const initial = { current, request: initialRequest, generation: 0 };
  const operation = () => input.operation ? input.operation() : initial;
  const capture = () => {
    const assigned = operation();
    return { request: assigned?.request ?? initialRequest, generation: assigned?.generation ?? -1,
      current: () => current() && !!assigned && assigned === operation() && assigned.current() };
  };
  let releaseHistory: (() => void) | undefined;
  let revision = 0;
  effect(() => {
    operation();
    releaseHistory?.(); releaseHistory = undefined;
    pending.set(false); revision++;
  });
  cleanup(() => { alive = false; releaseHistory?.(); releaseHistory = undefined; });
  const backupKey = `nsh:history-draft:v1:${input.storageKey}`;
  void Storage.getItem(backupKey).then(raw => {
    if (!input.current()) return;
    saved.set(historyDraftBackupFrom(raw, chat.referenceScope));
    ready.set(true);
  }).catch(failure => { if (input.current()) error.set(failure instanceof Error ? failure.message : t('miniChat.actions.failed')); });
  async function refresh(lane = capture()) {
    const { current, request } = lane;
    if (!current()) return;
    if (chat.refreshHistory) { await chat.refreshHistory(current); if (current()) uncertain.set(false); return; }
    const started = ++revision;
    const value = record(await request(`/api/session/${encodeURIComponent(target.id)}?${query(target.directory)}`));
    if (!current() || started !== revision) return;
    const session = record(value.data ?? value);
    if (session.id !== target.id) throw new Error('Invalid session history authority');
    revert.set(session.revert ? nativeRevertFrom(session.revert) : null);
    uncertain.set(false);
  }
  effect(() => {
    if (!current() || target.kind !== 'session' || chat.revert) return;
    void refresh().catch(failure => { if (current()) error.set(failure instanceof Error ? failure.message : t('miniChat.actions.failed')); });
  });
  function props(message: () => Message) {
    const lane = capture(), { current, request } = lane;
    const scope = { key: `${input.key}:${lane.generation}`, current, busy: () => chat.busy() || chat.sending(), message };
    let acquired = false;
    const release = () => { if (!acquired) return; acquired = false; if (!chat.messageScope || chat.messageScope.generation === lane.generation) chat.historyBusy?.set(false); if (releaseHistory === release) releaseHistory = undefined; };
    const onPending = (value: boolean) => {
      if (!value) { if (current()) release(); return; }
      if (!current()) throw new Error('history_operation_stale');
      chat.historyBusy?.set(true); acquired = true; releaseHistory = release;
    };
    const onChanged = async () => { if (!current()) return; await refresh(lane); if (current()) await chat.load(); };
    const onUncertain = () => { if (current()) uncertain.set(true); };
    return {
      target, message, scope: { ...scope, message }, send: request,
      canEditDraft: () => ready() && chat.draftStatus() === 'ready' && !chat.pendingSend() && !chat.queueEdit() && !saved().length,
      onEditDraft: async (draft: NativeEditDraft) => {
        if (chat.sending() || chat.pendingSend() || chat.queueEdit()) throw new Error('消息正在发送或有待恢复操作，未覆盖草稿');
        const previous = historyDraftSnapshot(chat);
        await Storage.setItem(backupKey, historyDraftBackupJSON([previous]));
        if (!current()) return;
        saved.set([previous]);
        if (chat.sending() || chat.pendingSend() || chat.queueEdit()) throw new Error('消息正在发送或有待恢复操作，未覆盖草稿');
        const next = { text: draft.text, files: draft.files, references: { text: draft.text, references: [], scope: { ...chat.referenceScope } } };
        if (!replaceHistoryDraft(chat, next, previous)) throw new Error('草稿已变化，已保留当前输入；请恢复回退后重试编辑');
        await chat.flushDraft();
      },
      onOpenChat: (target: ChatTarget) => { if (current()) input.onOpenChat(target); },
      onRevert: (value: NativeRevert | null) => { if (current()) revert.set(value); }, onChanged, onPending, onUncertain,
      onError: (failure: unknown) => { if (current()) error.set(failure instanceof Error ? failure.message : t('miniChat.actions.failed')); },
    };
  }
  async function redo() {
    const lane = capture(), { current } = lane;
    if (!current() || pending()) return;
    pending.set(true); error.set('');
    try { await createTranscriptActions(props(() => undefined as unknown as Message)).redo(); }
    catch (failure) { if (current()) error.set(failure instanceof Error ? failure.message : t('miniChat.actions.failed')); }
    finally { if (current()) pending.set(false); }
  }
  async function recover() {
    const lane = capture(), { current } = lane;
    if (!current() || pending() || chat.draftStatus() !== 'ready' || chat.sending() || chat.pendingSend() || chat.queueEdit()) return;
    const previous = saved()[0];
    if (!previous) return;
    // Swap, do not overwrite edits made since the historical transfer.
    const replacement = historyDraftSnapshot(chat);
    pending.set(true); error.set('');
    let acquired = false;
    try {
      chat.historyBusy?.set(true); acquired = true;
      const release = () => { if (acquired) { acquired = false; if (!chat.messageScope || chat.messageScope.generation === lane.generation) chat.historyBusy?.set(false); } if (releaseHistory === release) releaseHistory = undefined; };
      releaseHistory = release;
      const journal = [...saved(), replacement];
      await Storage.setItem(backupKey, historyDraftBackupJSON(journal));
      if (!current()) return;
      saved.set(journal);
      if (chat.sending() || chat.pendingSend() || chat.queueEdit() || !replaceHistoryDraft(chat, previous, replacement)) throw new Error('草稿已变化，未覆盖当前输入');
      await chat.flushDraft();
      if (!current()) return;
      const next = [...journal.slice(1, -1), replacement];
      await Storage.setItem(backupKey, historyDraftBackupJSON(next));
      if (current()) saved.set(next);
    } catch (failure) { if (current()) error.set(failure instanceof Error ? failure.message : t('miniChat.actions.failed')); }
    finally { if (current()) { if (acquired) { acquired = false; chat.historyBusy?.set(false); releaseHistory = undefined; } pending.set(false); } }
  }
  async function discard() {
    const lane = capture(), { current } = lane;
    if (!current() || pending()) return;
    const answer = await AlertDialog.show({ title: t('filesView.unsaved.discard'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [
      { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
    ] });
    if (!current() || answer.action !== 'discard' || pending()) return;
    pending.set(true);
    try { await Storage.setItem(backupKey, 'null'); if (current()) saved.set([]); }
    catch (failure) { if (current()) error.set(failure instanceof Error ? failure.message : t('miniChat.actions.failed')); }
    finally { if (current()) pending.set(false); }
  }
  function Indicator() {
    return <View class="gap-2 px-4">
      <If when={!!revert() || uncertain()}><View testID="history-revert-indicator" class="bg-card rounded-xl p-3 gap-2">
        <Text class="text-sm text-muted-foreground">{t('chat.revertPopover.title')}</Text>
        <Each of={revert()?.files ?? []}>{file => <Text class="text-xs text-muted-foreground">{String(file().file || file().path || '')}</Text>}</Each>
        <Button testID="history-redo" class={action} disabled={pending() || chat.busy() || chat.sending()} onPress={() => { void redo(); }}><Text class="text-foreground">{t('chat.revertIndicator.redo')}</Text></Button>
      </View></If>
      <If when={saved().length > 0}><View class="flex-row gap-2">
        <Button testID="history-draft-recover" class={action} disabled={pending() || chat.draftStatus() !== 'ready' || chat.sending() || !!chat.pendingSend() || !!chat.queueEdit()} onPress={() => { void recover(); }}><Text class="text-foreground">{t('chat.revertPopover.restore')}</Text></Button>
        <Button testID="history-draft-discard" class={action} disabled={pending()} onPress={() => { void discard(); }}><Text class="text-foreground">{t('filesView.unsaved.discard')}</Text></Button>
      </View></If>
      <If when={!!error()}><Text class="text-sm text-destructive">{error()}</Text></If>
    </View>;
  }
  return { props, Indicator };
}
