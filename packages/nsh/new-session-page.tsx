import { cleanup, computed, effect, Keyboard, keyboardFrame, lifecycle, Overlay, platform, safeArea, signal, Speech, Scroll, Text, token, untracked, View, windowSize, type InputRef, type JSX, type SpeechSession, type ViewRef } from 'nsh';
import { AlertDialog, Button, Input, NavPage } from 'nsh/base';
import { nativeChatTextStyle } from './appearance';
import { NativeAgentAvatar, NativeModelLogo, nativeAgentAccent } from './chat-identity';
import { pickerPreferences, pickerSheetHeight } from './chat-models-helpers';
import { NativeCommandSuggestions } from './composer-controls';
import { nativeComposerSurface } from './composer-surface';
import { desktopChatGeometry } from './desktop-chat-layout-core';
import { shouldSubmitCommandOnSelection } from './composer-commands-model';
import { createNativeNewSessionLocalCommands } from './new-session-local-commands';
import type { NativeLocalCommandOutcome } from './composer-local-commands';
import { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';
import { NativeReferencePicker } from './composer-references-controls';
import { NativeComposerSend } from './composer-send';
import { Icon } from './Icon';
import { currentLocale, t } from './i18n';
import { id, nameOf, record, rowsFrom, sessionsFrom, text, type Attachment, type ChatTarget, type Project, type Row, type Session } from './model';
import { createDesktopAttachments, type DesktopAttachmentReceipt } from './desktop-attachments';
import { desktopAttachmentRecovery } from './desktop-attachments-recovery';
import { createNativeNewSessionOwnership, desktopGitDraftAuthority, type NativeNewSessionPageHandoff, type NativeNewSessionHandoff, type NativeNewSessionFolderTarget, type NativeNewSessionOwner } from './new-session';
import type { DesktopGitContextInput } from './desktop-git-dispatch';
import type { DesktopGitOwnerPublisher } from './desktop-git-dispatch-owner';
import { newSessionText } from './new-session-copy';
import { NativeNewSessionModels } from './new-session-models';
import { NativeNewSessionModal } from './new-session-modal';
import { NativeNewSessionInputAX } from './new-session-native-owners';
import { native } from './runtime';
import { createPageOperations } from './page-operations';
import { createNewSessionWriterAdmission, createNewSessionWriterAdmissionGuard, type NewSessionWriterAdmissionGuard } from './new-session-writer';
import { resolveNewSessionWriterDirectory } from './new-session-directory';
import type { DesktopWriterClient } from './desktop-writer-core';
import { app, captureHostRequest } from './state';
import { formatEffortLabel, getAgentDisplayName, getCycledPrimaryAgentName, getModelDisplayName } from '../ui/src/components/chat/mobileControlsUtils';
import { LONG_PRESS_MS, LONG_PRESS_MOVE_PX } from '../ui/src/lib/touch-gestures/tap';
import { createNewSessionCatalog } from './new-session-selection';
import { createNativeDesktopComposerShortcutOwner, nativeDesktopNextModelVariant, type NativeDesktopComposerShortcutOwner, type NativeDesktopComposerShortcutPublisher } from './desktop-composer-actions';
import { agentDraftSelection, closestStarter, createAgentPress, getBuiltInStarter, globalStarterRefs, moveStarter, projectStarterConfig, projectStarterLocation, resolveStarters, sanitizeStarterRefs, STARTER_TRASH, starterKey, starterOptions, starterShifts, type DraftStarterRef, type StarterGroup, type StarterItem, type StarterRect } from './new-session-ui-helpers';

type Ownership = ReturnType<typeof createNativeNewSessionOwnership>;
type OwnershipIntent = Parameters<typeof createNativeNewSessionOwnership>[0];
const action = 'min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';

export interface NativeNewSessionPageProps {
  project?: Project;
  directory?: string;
  active: boolean;
  projects?: Project[];
  /** Original window-root client; ignored by iOS. Never load capabilities here. */
  desktopWriter?: () => DesktopWriterClient | undefined;
  /** Current active owner only; undefined clears the model but retains directory. */
  onSelection?: (directory: string, selection?: { providerID: string; modelID: string; variant?: string }, agent?: string) => void;
  onDesktopShortcuts?: NativeDesktopComposerShortcutPublisher;
  onDesktopOwner?: DesktopGitOwnerPublisher;
  /** Captured route intent only; the publisher owns staging and overwrite confirmation. */
  initialContext?: DesktopGitContextInput;
  initialFolder?: NativeNewSessionFolderTarget;
  /** Lifecycle pointer only. Inactive pages never gain mutation authority from publication. */
  onRetainedOwner?: (owner: NativeNewSessionOwner) => void | (() => void);
  /** Pre-source lifetime only. Root adds route metadata; never stores a grant here. Ignored by iOS. */
  onWriterAdmissionGuard?: (guard: NewSessionWriterAdmissionGuard) => void | (() => void);
  onUserIntent?: () => void;
  onOpenChat: (target: ChatTarget, handoff: NativeNewSessionPageHandoff) => void;
  /** Notification only: native NavStack has already popped. Do not pop again. */
  onBack?: () => void;
}

export function NativeNewSessionPage(props: NativeNewSessionPageProps) {
  let alive = true;
  const current = () => alive && props.active && lifecycle() === 'active';
  const ownership = signal<Ownership | null>(null), switching = signal(false), error = signal(''), starterGesture = signal(false);
  const creation = signal<OwnershipIntent | null>(null);
  let installedIntent: OwnershipIntent | null = null;
  let retireRetainedOwner: (() => void) | undefined;
  const initialContext = props.initialContext;
  let publishedOwner: { owner: Ownership['owner']; publish: DesktopGitOwnerPublisher } | undefined;
  function retireDesktopOwner() {
    const previous = publishedOwner;
    publishedOwner = undefined;
    previous?.publish({ type: 'retire', owner: previous.owner });
  }
  function open(project?: Project, directory?: string, folder?: NativeNewSessionFolderTarget) {
    if (platform?.desktop && !current()) return;
    const connection = app.connection();
    const draftAuthorityKey = platform?.desktop && connection ? desktopGitDraftAuthority(connection) : undefined;
    creation.set({ project, directory, active: current, draftAuthorityKey, ...(folder ? { folder } : {}) });
  }
  function adoptOwner(entry: Ownership, intent: OwnershipIntent) {
    retireRetainedOwner?.(); retireRetainedOwner = undefined;
    installedIntent = intent; ownership.set(entry);
    const retire = props.onRetainedOwner?.(entry.owner);
    if (typeof retire === 'function') retireRetainedOwner = retire;
    return !!props.onRetainedOwner;
  }
  function retireOwner(entry: Ownership) { if (ownership() === entry) { retireRetainedOwner?.(); retireRetainedOwner = undefined; ownership.set(null); } }
  open(props.project, props.directory, props.initialFolder);
  async function changeProject(project: Project | undefined, directory: string) {
    const previous = ownership();
    if (!current() || switching() || !previous || previous.owner.phase() !== 'draft' || previous.owner.submitting() || previous.owner.folderChanging()) return;
    const operation = previous.owner.operation()!;
    props.onUserIntent?.();
    switching.set(true); error.set('');
    try {
      const nextDirectory = platform?.desktop ? await resolveNewSessionWriterDirectory({ directory, read: operation.request, current: () => current() && operation.current() }) : directory;
      if (platform?.desktop && nextDirectory === previous.owner.directory) return;
      // Flush before retiring the current partition. Failed persistence keeps the
      // existing page/input instead of silently opening an empty new partition.
      await previous.owner.durable.flush();
      if (!current() || !operation.current()) return;
      await previous.disposePage();
      if (!alive || !operation.current()) return;
      open(project, nextDirectory);
    } catch { if (alive) error.set(newSessionText('storageFailed')); }
    finally { if (alive) switching.set(false); }
  }
  async function openNewDraft(): Promise<NativeLocalCommandOutcome> {
    const previous = ownership(), intent = creation();
    if (!current() || !previous || previous.transferred() || previous.owner.phase() !== 'draft') return { status: 'rejected' };
    if (platform?.desktop) return { status: 'accepted' };
    await changeProject(previous.owner.project.id ? previous.owner.project : undefined, previous.owner.directory);
    // This is the actual page's ownership/navigation intent, not a successful click or remote create.
    return { status: creation() !== intent && creation()?.directory === previous.owner.directory ? 'accepted' : 'rejected' };
  }
  effect(() => {
    const entry = ownership(), intent = creation();
    if (intent && intent !== installedIntent) return;
    if (platform?.desktop && current() && !switching() && (!entry || !entry.transferred() && !entry.owner.ownedScope())) {
      if (entry) void entry.disposePage().catch(() => {});
      open(entry?.owner.project.id ? entry.owner.project : props.project, entry?.owner.directory ?? props.directory, installedIntent ? undefined : props.initialFolder);
      return;
    }
    if (!current() || !entry?.transferred() || !entry.released()) return;
    open(entry.owner.project.id ? entry.owner.project : undefined, entry.owner.directory);
  });
  effect(() => {
    const entry = ownership(), publish = props.onDesktopOwner;
    const owner = platform?.desktop && current() && !switching() && entry && !entry.transferred() && !entry.released() && entry.owner.current() ? entry.owner : undefined;
    untracked(() => {
      if (publishedOwner?.owner === owner && publishedOwner?.publish === publish) return;
      retireDesktopOwner();
      if (!owner || !publish || !owner.current()) return;
      publishedOwner = { owner, publish };
      const context = initialContext?.sessionID === null && initialContext.hostID === owner.hostID && initialContext.authorityKey === owner.draftAuthorityKey && initialContext.directory === owner.directory ? initialContext : undefined;
      publish({ type: 'register', owner, ...(context ? { initialContext: context } : {}) });
    });
  });
  cleanup(() => { alive = false; retireRetainedOwner?.(); retireRetainedOwner = undefined; retireDesktopOwner(); void ownership()?.disposePage().catch(() => {}); });
  const content = <>
    <If when={!!error()}><View class="p-4 gap-2"><Text role="alert" class="text-sm text-destructive">{error()}</Text><If when={!ownership()}><Button class={action} onPress={() => { error.set(''); open(props.project, props.directory); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If></View></If>
    <Each of={creation() ? [creation()!] : []}>{intent => <NewSessionOwnershipSlot intent={intent()} desktopWriter={props.desktopWriter} onWriterAdmissionGuard={props.onWriterAdmissionGuard} projects={() => props.projects ?? app.projects()} onUserIntent={props.onUserIntent} onChooseDirectory={(project, directory) => { if (current()) { props.onUserIntent?.(); open(project, directory); } }} onReady={entry => adoptOwner(entry, intent())} onRetire={retireOwner} onError={() => error.set(t('common.unavailable'))}>{entry => <NewSessionBody ownership={entry} active={current} projects={() => props.projects ?? app.projects()} switching={switching} onChangeProject={changeProject} onNewDraft={openNewDraft} onOpenChat={props.onOpenChat} onSelection={props.onSelection} onDesktopShortcuts={props.onDesktopShortcuts} onUserIntent={props.onUserIntent} onStarterGestureChange={active => starterGesture.set(active)} />}</NewSessionOwnershipSlot>}</Each>
  </>;
  return platform?.desktop ? <View testID="new-session-page" class="flex-1 bg-background">{content}</View> : <NavPage testID="new-session-page" title={t('mobile.menu.newSession')} headerBackTitle="" class="flex-1 bg-background" popOnSwipe={!current() || !starterGesture()} onDismiss={() => { starterGesture.set(false); void ownership()?.disposePage().catch(() => {}); props.onBack?.(); }}>{content}</NavPage>;
}

/** Construct lifecycle owners under a stable JSX component, never a rerunning effect. */
type OwnershipSlotProps = { intent: OwnershipIntent; desktopWriter?: () => DesktopWriterClient | undefined; onWriterAdmissionGuard?: NativeNewSessionPageProps['onWriterAdmissionGuard']; projects: () => Project[]; onUserIntent?: () => void; onChooseDirectory: (project: Project | undefined, directory: string) => void; onReady: (entry: Ownership) => boolean | void; onRetire: (entry: Ownership) => void; onError: () => void; children: (entry: Ownership) => JSX.Element };
function NewSessionOwnershipSlot(props: OwnershipSlotProps) {
  if (!platform?.desktop) return <AdmittedNewSessionOwnershipSlot {...props} />;
  const operations = createPageOperations(), admitted = signal<OwnershipIntent | null>(null), revision = signal(0);
  const selected = props.intent.directory ?? props.intent.project?.path;
  const captured = app.connection();
  let retired = false, alive = true, installed = false, handedOff = false;
  let admission: ReturnType<typeof createNewSessionWriterAdmission> | undefined;
  const sameHost = () => {
    const next = app.connection();
    if (!next || next.id !== captured?.id || next.url !== captured.url || next.authorizationID !== captured.authorizationID) retired = true;
    return !retired;
  };
  const safeWaiting = () => !installed && (!admission || admission.safeToLeave());
  const guard = createNewSessionWriterAdmissionGuard({ current: () => alive && !handedOff, safe: safeWaiting });
  let unregister = untracked(() => props.onWriterAdmissionGuard?.(guard));
  const stopGuard = () => { guard.cancel(); const stop = unregister; unregister = undefined; if (typeof stop === 'function') stop(); };
  effect(() => {
    app.connection(); untracked(sameHost);
    const operation = operations.operation(), client = props.desktopWriter?.();
    if (!selected || !operation || !client || installed) return;
    untracked(() => {
      const attempt = admission ? admission.resume(operation) : (admission = createNewSessionWriterAdmission({ client, directory: selected, operation, current: sameHost, changed: () => revision.set(untracked(revision) + 1) })).ready();
      void attempt.then(value => {
        if (!alive || !value || !operation.current()) return;
        admitted.set({ ...props.intent, directory: value.directory, desktopWriter: value });
      });
    });
  });
  cleanup(() => { alive = false; stopGuard(); if (!installed) void admission?.close({ allowed: () => true }); });
  const waiting = () => {
    revision();
    const phase = admission?.snapshot().phase;
    return !!selected && (!admission || phase === 'resolving' || phase === 'acquiring');
  };
  return <>
    <Each of={admitted() ? [admitted()!] : []}>{intent => <AdmittedNewSessionOwnershipSlot {...props} intent={intent()} onReady={entry => { installed = true; const retained = props.onReady(entry); if (retained) { handedOff = true; stopGuard(); } }} />}</Each>
    <If when={!admitted()}><NewSessionUnadmitted selected={selected} waiting={waiting} current={() => props.intent.active() && sameHost()} projects={props.projects} choose={(project, directory) => { if (alive && safeWaiting()) props.onChooseDirectory(project, directory); }} onUserIntent={props.onUserIntent} /></If>
  </>;
}

/** Presentation only: no draft/receipt owner, restore, catalog or writer calls. */
function NewSessionUnadmitted(props: { selected: string | undefined; waiting: () => boolean; current: () => boolean; projects: () => Project[]; choose: (project: Project | undefined, directory: string) => void; onUserIntent?: () => void }) {
  const open = signal(false);
  let alive = true, choice: { project: Project | undefined; directory: string } | undefined;
  const current = () => alive && props.current();
  cleanup(() => { alive = false; });
  return <NewSessionLayout><View testID={props.selected ? 'new-session-writer-waiting' : 'new-session-choose-project'} class="w-full gap-2">
    <NewSessionWelcome><View class="items-center"><Text class="text-foreground" style={{ fontSize: 30, lineHeight: 36, fontWeight: '400', letterSpacing: -0.75, textAlign: 'center', maxWidth: 780 }}>{t('chat.emptyState.draftTitle')}</Text></View></NewSessionWelcome>
    <If when={!!props.selected}><Text class="text-sm text-muted-foreground">{props.waiting() ? t('common.loading') : t('common.unavailable')}</Text></If>
    <View testID="desktop-new-session-targets" class="mb-1 flex-row flex-wrap items-center gap-2"><Button testID="new-session-project" class="h-[26px] px-1.5 flex-row items-center gap-1.5 rounded-lg hover:bg-accent active:bg-accent disabled:opacity-40" disabled={!current()} onPress={() => { if (current()) { props.onUserIntent?.(); open.set(true); } }}><Icon name="folder" size={14} /><Text class="text-foreground" style={{ fontSize: 12, lineHeight: 16 }}>{props.selected ?? t('sessions.scheduledTasks.dialog.error.chooseProjectFirst')}</Text><Icon name="arrow-down-s" size={12} /></Button></View>
    <If when={!props.selected}><View testID="new-session-composer-glass" class={platform?.desktop ? 'relative min-w-0' : 'px-3 pt-1 pb-1'} style={platform?.desktop ? { borderRadius: 24, borderWidth: 1, borderColor: 'transparent', backgroundColor: token('background') } : nativeComposerSurface}>
      <If when={platform?.desktop}><View accessible={false} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 23, pointerEvents: 'none', backgroundColor: token('foreground'), opacity: 0.08 }} /></If>
      <View style={platform?.desktop ? { paddingTop: 4 } : undefined}><Input testID="new-session-composer" class={platform?.desktop ? 'text-foreground' : 'min-h-[52px] max-h-36 py-[10px] text-foreground'} style={platform?.desktop ? { ...nativeChatTextStyle('composer'), minHeight: 52, maxHeight: 160, paddingHorizontal: 12, paddingTop: 16, paddingBottom: 8, backgroundColor: 'transparent', borderWidth: 0 } : { ...nativeChatTextStyle('composer'), backgroundColor: 'transparent', borderWidth: 0 }} multiline readonly value="" placeholder={t('chat.chatInput.placeholder.chat')} /></View>
      <View class={platform?.desktop ? 'flex-row items-center' : 'min-h-10 flex-row items-center gap-1.5'} style={platform?.desktop ? { minHeight: 36, paddingHorizontal: 10, paddingVertical: 6, gap: 6 } : undefined}><Button testID="new-session-attach" class="size-8 rounded-full items-center justify-center disabled:opacity-40" disabled accessibilityLabel={t('chat.chatInput.actions.addAttachment')}><Icon name="attachment-2" size={18} /></Button><Button testID="new-session-dictate" class="size-8 rounded-full items-center justify-center disabled:opacity-40" disabled accessibilityLabel={t('chat.dictation.start')}><Icon name="mic" size={18} /></Button><View class="flex-1" /><Button testID="new-session-model" class="flex-row items-center gap-1 rounded-lg disabled:opacity-40" disabled><Text class="text-foreground" style={{ fontSize: 11, lineHeight: 14 }}>{t('chat.modelControls.selectModel')}</Text></Button><NativeComposerSend presentation="desktop" active={false} hasContent={false} inFlight={false} disabled onPress={() => {}} /></View>
    </View><Text class="text-sm text-muted-foreground">{t('sessions.scheduledTasks.dialog.error.chooseProjectFirst')}</Text></If>
    <NativeNewSessionModal value={open() ? 'project' : null} active={current} onClose={() => open.set(false)} onDismiss={() => { const selected = choice; choice = undefined; if (selected && current()) props.choose(selected.project, selected.directory); }} height={pickerSheetHeight(windowSize().height, safeArea())}>{(_value, active, close) => <NewSessionProjects owner={{ directory: props.selected ?? '' }} projects={props.projects} current={active} onChoose={async (project, directory) => { if (active()) { choice = { project, directory }; close(); } }} />}</NativeNewSessionModal>
  </View></NewSessionLayout>;
}

function AdmittedNewSessionOwnershipSlot(props: OwnershipSlotProps) {
  let entry: Ownership;
  try { entry = createNativeNewSessionOwnership(props.intent); }
  catch { untracked(props.onError); return null; }
  untracked(() => props.onReady(entry));
  cleanup(() => { untracked(() => props.onRetire(entry)); void entry.disposePage().catch(() => {}); });
  return props.children(entry);
}

function NewSessionLayout(props: { children?: JSX.Element }) {
  // Web `.chat-input-column` uses the window breakpoint, then its own inline padding.
  // The measured shell is that column minus both insets: 752pt at this viewport.
  const column = desktopChatGeometry(windowSize().width);
  const shell = Math.max(1, column.columnMax - column.columnInset * 2);
  return platform?.desktop
    ? <Scroll testID="desktop-new-session-layout" class="flex-1" contentClass="grow items-center justify-center" contentStyle={{ paddingBottom: Math.max(32, windowSize().height * .06) }}><View testID="desktop-new-session-column" class="self-center min-w-0" style={{ width: shell }}>{props.children}</View></Scroll>
    : <View class="flex-1">{props.children}</View>;
}

function NewSessionWelcome(props: { children?: JSX.Element }) {
  return platform?.desktop
    ? <View testID="desktop-new-session-welcome" class="mb-7 gap-4">{props.children}</View>
    : <Scroll class="flex-1" contentClass="grow justify-center px-6 py-4 gap-4">{props.children}</Scroll>;
}

function NewSessionBody(props: { ownership: Ownership; active: () => boolean; projects: () => Project[]; switching: () => boolean; onChangeProject: (project: Project | undefined, directory: string) => Promise<void>; onNewDraft: () => Promise<NativeLocalCommandOutcome>; onOpenChat: NativeNewSessionPageProps['onOpenChat']; onSelection?: NativeNewSessionPageProps['onSelection']; onDesktopShortcuts?: NativeDesktopComposerShortcutPublisher; onUserIntent?: () => void; onStarterGestureChange?: (active: boolean) => void }) {
  const request = captureHostRequest();
  const ownership = props.ownership, owner = ownership.owner;
  const panel = signal<'model' | 'agent' | 'project' | 'branch' | null>(null), mode = signal<'normal' | 'shell'>('normal');
  const error = signal(''), pending = signal(false), attaching = signal(false), recording = signal(false), commands = signal<Row[]>([]);
  const anchor = signal<ViewRef | null>(null);
  const composerWidth = signal(0);
  const composing = signal(false), composerFocused = signal(false), desktopSelection = signal<NativeDesktopComposerShortcutOwner | null>(null), desktopSelectionPending = signal(false), starterPanel = signal(false);
  const modelProviders = signal<Row[]>([]), dictationEnabled = signal(false);
  const confirmingLocalCommand = signal(false);
  let input: InputRef | undefined;
  let alive = true, speech: SpeechSession | undefined, speechOperation = 0;
  let pendingProject: { project: Project | undefined; directory: string } | undefined;
  const current = () => alive && props.active() && owner.current() && !props.switching();
  const userIntent = () => { if (current()) props.onUserIntent?.(); };
  const selectionEnabled = () => current() && owner.phase() === 'draft' && !owner.submitting() && !owner.folderChanging();
  const attachmentRecoveryKey = JSON.stringify([owner.durable.scope, app.connection()?.url, app.connection()?.authorizationID]);
  const attachmentStatus = signal<DesktopAttachmentReceipt | null>(platform?.desktop ? desktopAttachmentRecovery.get(attachmentRecoveryKey)?.receipt ?? null : null);
  const attachmentFailure = signal(false), attachmentRefreshing = signal(false);
  type AttachmentOperation = ReturnType<typeof owner.captureOperation>;
  type AttachmentOwner = { authority: NonNullable<ReturnType<typeof owner.operation>>; captured: AttachmentOperation; controller: ReturnType<typeof createDesktopAttachments>; retired: boolean; cancelRequested: boolean };
  let attachmentOwner: AttachmentOwner | undefined, attachmentUi = 0;
  let attachmentFlight: { authority: ReturnType<typeof owner.operation>; captured: AttachmentOperation } | undefined;
  if (platform?.desktop) cleanup(owner.bindRetirementGuard(() => !pending() && !attaching() && !recording() && !desktopSelectionPending() && !confirmingLocalCommand()
    && !attachmentFlight && !attachmentOwner?.controller.blocked() && !desktopAttachmentRecovery.get(attachmentRecoveryKey)));
  if (platform?.desktop && attachmentStatus()) attaching.set(true);
  const attachmentCurrent = (entry: AttachmentOwner) => current() && !entry.retired && attachmentOwner === entry && owner.operation() === entry.authority && entry.captured.current();
  function rememberAttachment(entry: AttachmentOwner) {
    const receipt = entry.controller.receipt();
    if (!receipt || !entry.captured.scope) return;
    if (!entry.retired && !entry.controller.blocked() && (receipt.state === 'ready' || entry.cancelRequested && !receipt.unresolved)) desktopAttachmentRecovery.forget(attachmentRecoveryKey, receipt.requestID);
    else desktopAttachmentRecovery.remember(attachmentRecoveryKey, entry.captured.scope, receipt);
  }
  function presentAttachment(entry: AttachmentOwner) {
    rememberAttachment(entry);
    if (!attachmentCurrent(entry)) return;
    const receipt = entry.controller.receipt();
    attachmentStatus.set(receipt);
    attaching.set(entry.controller.blocked());
    attachmentFailure.set(receipt?.state === 'failed' || receipt?.state === 'unknown');
  }
  function retireAttachment() {
    const entry = attachmentOwner;
    attachmentUi++; attachmentFlight = undefined;
    if (entry && !entry.retired) {
      entry.retired = true;
      // Keep only the exact receipt/lease for runtime-only readback. The original draft
      // persists already-adopted files; unknown bytes cannot be reconstructed after a crash.
      rememberAttachment(entry);
      void entry.controller.cancel().finally(() => rememberAttachment(entry)).catch(() => {});
    }
  }
  if (platform?.desktop) {
    effect(() => {
      const authority = owner.operation(), available = current() && owner.phase() === 'draft' && !owner.submitting();
      if ((!attachmentOwner || attachmentOwner.retired || available && attachmentOwner.authority === authority && attachmentOwner.captured.current())
        && (!attachmentFlight || available && attachmentFlight.authority === authority && attachmentFlight.captured.current())) return;
      retireAttachment();
      attachmentRefreshing.set(false);
      attachmentStatus.set(desktopAttachmentRecovery.get(attachmentRecoveryKey)?.receipt ?? null);
      attaching.set(!!desktopAttachmentRecovery.get(attachmentRecoveryKey));
    });
    cleanup(() => { retireAttachment(); });
  }
  let publishedSelection: string | undefined;
  effect(() => {
    if (!props.onSelection || !current()) { publishedSelection = undefined; return; }
    const draftSelection = owner.selection(), model = draftSelection.model;
    const selection = model?.providerID && model.id ? { providerID: model.providerID, modelID: model.id, ...(model.variant !== undefined ? { variant: model.variant } : {}) } : undefined;
    const signature = JSON.stringify([owner.directory, selection, draftSelection.agent]);
    if (signature === publishedSelection) return;
    publishedSelection = signature;
    untracked(() => props.onSelection?.(owner.directory, selection, draftSelection.agent));
  });
  function handoffToChat(receipt: NativeNewSessionHandoff): NativeLocalCommandOutcome {
    if (!current() || ownership.transferred()) return { status: 'unknown' };
    Keyboard.dismiss(); panel.set(null); stopSpeech();
    const handoff = ownership.transfer(receipt);
    try { props.onOpenChat(receipt.target, handoff); return { status: 'accepted' }; }
    catch { ownership.reclaim(handoff); error.set(newSessionText('operationFailed')); return { status: 'unknown' }; }
  }
  const local = platform?.desktop ? createNativeNewSessionLocalCommands({ owner, current,
    editing: () => !panel() && !starterPanel() && !composing() && !recording(), pending, inputMode: mode, t,
    focus: () => { if (current() && !panel() && !recording()) input?.focus(); },
    onConfirming: value => confirmingLocalCommand.set(value), onPending: value => pending.set(value),
    onFailure: () => { if (current()) error.set(t('common.unavailable')); }, onUnknown: () => { if (current()) error.set(t('chat.questionDelegate.uncertain')); },
    openModel: () => { if (!selectionEnabled()) return { status: 'rejected' }; Keyboard.dismiss(); panel.set('model'); return { status: panel() === 'model' ? 'accepted' : 'rejected' }; },
    openNewDraft: props.onNewDraft, handoff: handoffToChat,
  }) : undefined;
  const keyboard = createNativeReferenceKeyboard({ active: () => current() && !panel() && !confirmingLocalCommand() && (mode() === 'normal' || platform?.desktop) && !recording(), scope: () => owner.durable.scope, text: () => mode() === 'normal' ? owner.durable.draft() : '', insert: (...args: Parameters<typeof owner.insertReference>) => { if (!current()) return false; userIntent(); return owner.insertReference(...args); },
    onSubmit: () => { if (platform?.desktop) void submit(); },
    chooseCommand: (command, submitIntent, context) => {
      if (!current()) return false;
      userIntent();
      if (local) return local.choose(command, submitIntent, context);
      if (shouldSubmitCommandOnSelection(command, submitIntent)) {
        owner.setDraftText(context.text.slice(context.end)); Keyboard.dismiss(); panel.set('model');
      } else {
        owner.setDraftText(`/${command.name} ${context.text.slice(context.end)}`);
      }
    },
  });
  const stopSpeech = () => { speechOperation++; speech?.abort(); speech = undefined; recording.set(false); };
  effect(() => {
    if (current()) return;
    panel.set(null); keyboard.dismiss(); stopSpeech(); void owner.durable.flush().catch(() => {});
  });
  cleanup(() => { alive = false; local?.dispose(); stopSpeech(); });
  async function perform(work: () => Promise<unknown>) {
    if (!current() || pending()) return;
    pending.set(true); error.set('');
    try { await work(); }
    catch (failure) {
      if (alive && props.active()) error.set(failure instanceof Error && failure.message === 'new-session-recovery-not-empty' ? newSessionText('recoveryNotEmpty') : failure instanceof Error && failure.message === 'new-session-recovery-directory-mismatch' ? newSessionText('recoveryMismatch') : newSessionText('operationFailed'));
    } finally { pending.set(false); }
  }
  async function submit() {
    if (!current() || composing() || confirmingLocalCommand() || owner.submitting() || owner.folderChanging() || ownership.transferred() || pending() || attaching() || recording() || platform?.desktop && desktopSelectionPending()) return;
    userIntent();
    if (local && owner.phase() === 'draft' && local.trySubmit()) return;
    if (!platform?.desktop && mode() === 'normal' && /^\/model(?:\s|$)/i.test(owner.durable.draft().trim())) {
      owner.setDraftText(owner.durable.draft().trimStart().replace(/^\/model\s*/i, ''));
      Keyboard.dismiss(); panel.set('model'); return;
    }
    await perform(async () => {
      const receipt = await owner.submit({ inputMode: mode() });
      if (!receipt || !current()) return;
      const result = handoffToChat(receipt);
      if (result.status !== 'accepted') throw new Error('new-session-navigation-unconfirmed');
    });
  }
  async function attach() {
    if (platform?.desktop) { await attachDesktop(); return; }
    if (!current() || attaching() || mode() === 'shell') return;
    const captured = owner.captureOperation();
    attaching.set(true);
    try {
      const choice = await AlertDialog.show({ title: t('chat.chatInput.actions.addAttachment'), presentation: platform?.desktop ? 'alert' : 'actionSheet', actions: [{ id: 'images', label: t('chat.chatInput.actions.attachPhotos') }, { id: 'files', label: t('chat.chatInput.actions.attachFiles') }, { id: 'cancel', label: t('chat.chatInput.actions.attachCancel'), role: 'cancel' }] });
      if (!current() || !captured.current() || choice.action !== 'files' && choice.action !== 'images') return;
      const attachment = await native<Attachment | null>('runtime.pickAttachment', { kind: choice.action });
      if (current() && captured.current() && attachment) owner.setAttachments([...owner.durable.attachments(), attachment]);
    } catch { if (current()) error.set(newSessionText('operationFailed')); }
    finally { if (alive) attaching.set(false); }
  }
  async function attachDesktop() {
    if (!current() || attaching() || mode() === 'shell') return;
    const captured = owner.captureOperation(), authority = owner.operation(), ticket = ++attachmentUi;
    const valid = () => current() && captured.current() && owner.operation() === authority && ticket === attachmentUi;
    attachmentFlight = { captured, authority };
    attaching.set(true); attachmentFailure.set(false);
    try {
      const choice = await AlertDialog.show({ title: t('chat.chatInput.actions.addAttachment'), presentation: 'alert', actions: [{ id: 'images', label: t('chat.chatInput.actions.attachPhotos') }, { id: 'files', label: t('chat.chatInput.actions.attachFiles') }, { id: 'cancel', label: t('chat.chatInput.actions.attachCancel'), role: 'cancel' }] });
      if (!valid() || choice.action !== 'files' && choice.action !== 'images') return;
      if (!captured.scope || !authority) throw new Error('scope_required');
      if (!attachmentOwner || attachmentOwner.retired || attachmentOwner.authority !== authority) {
        if (!desktopAttachmentRecovery.available(attachmentRecoveryKey)) throw new Error('attachment_receipt_unresolved');
        const controller = createDesktopAttachments({ scope: captured.scope, native, id });
        attachmentOwner = { authority, captured, controller, retired: false, cancelRequested: false };
      }
      const entry = attachmentOwner;
      if (!desktopAttachmentRecovery.available(attachmentRecoveryKey)) throw new Error('attachment_receipt_unresolved');
      const flight = entry.controller.pick(choice.action, { current: () => attachmentCurrent(entry), read: owner.durable.attachments, write: files => attachmentCurrent(entry) && owner.setAttachments(files) });
      const receipt = entry.controller.receipt();
      if (receipt) desktopAttachmentRecovery.begin(attachmentRecoveryKey, captured.scope, receipt);
      rememberAttachment(entry);
      await flight;
      presentAttachment(entry);
    } catch { if (valid()) { attachmentFailure.set(true); if (attachmentOwner) rememberAttachment(attachmentOwner); } }
    finally {
      if (valid()) {
        attachmentFlight = undefined;
        attaching.set(attachmentOwner?.controller.blocked() === true || !!desktopAttachmentRecovery.get(attachmentRecoveryKey));
        if (attachmentOwner) attachmentStatus.set(attachmentOwner.controller.receipt());
      }
    }
  }
  async function checkAttachment(cancel = false) {
    if (!current() || attachmentRefreshing()) return;
    if (cancel && attachmentFlight && (!attachmentOwner || !attachmentOwner.controller.blocked())) {
      attachmentUi++; attachmentFlight = undefined;
      attaching.set(false); attachmentFailure.set(false); attachmentStatus.set(null);
      return;
    }
    const captured = owner.captureOperation(), authority = owner.operation(), ticket = attachmentUi;
    const valid = () => current() && captured.current() && owner.operation() === authority && ticket === attachmentUi;
    const entry = attachmentOwner;
    attachmentRefreshing.set(true);
    try {
      if (entry && !entry.retired && attachmentCurrent(entry)) {
        if (cancel) { entry.cancelRequested = true; await entry.controller.cancel(); }
        else await entry.controller.reconcile();
        presentAttachment(entry);
      } else {
        const result = await desktopAttachmentRecovery.inspect(attachmentRecoveryKey, native, cancel);
        if (!valid()) return;
        const saved = desktopAttachmentRecovery.get(attachmentRecoveryKey)?.receipt;
        attachmentStatus.set(saved ? { ...saved, ...(result ? { state: result.state, orphaned: result.orphaned } : {}) } : null);
        attaching.set(!!saved);
        attachmentFailure.set(!!saved);
      }
    } catch { if (valid()) attachmentFailure.set(true); }
    finally { if (valid()) { attachmentRefreshing.set(false); if (entry) rememberAttachment(entry); } }
  }
  async function dictate() {
    if (recording()) { speech?.stop(); return; }
    if (!current()) return;
    userIntent();
    const captured = owner.captureOperation();
    const operation = ++speechOperation;
    try {
      if (!await Speech.available()) throw new Error('unavailable');
      if (!current() || !captured.current() || operation !== speechOperation) return;
      const initial = owner.durable.draft(); speech = Speech.start({ interim: true }); recording.set(true);
      speech.on('result', result => { if (current() && captured.current() && operation === speechOperation) owner.setDraftText(initial + (initial ? '\n' : '') + result.text); });
      speech.on('end', result => { if (operation === speechOperation) { speech = undefined; recording.set(false); if (result.error && current()) error.set(t('chat.dictation.failed')); } });
    } catch { if (current() && operation === speechOperation) error.set(t('chat.dictation.failed')); }
  }
  async function loadCommands() {
    if (!current() || !owner.directory) return;
    const captured = owner.captureOperation();
    const result = rowsFrom(await captured.request(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(owner.directory)}`));
    if (current() && captured.current()) commands.set(result);
  }
  const hasContent = () => !!owner.durable.draft().trim() || owner.durable.attachments().length > 0;
  const composerEnabled = () => current() && !owner.submitting() && owner.status() === 'ready' && owner.durable.status() === 'ready' && !pending() && !confirmingLocalCommand() && !attaching() && !desktopSelectionPending() && !ownership.transferred();
  const editEnabled = () => composerEnabled() && owner.phase() === 'draft';
  const inputReady = signal(false);
  const composerRef = (node: InputRef) => { input = node; keyboard.ref(node); inputReady.set(!!node); };
  const onCompositionChange = (event: { composing: boolean }) => { composing.set(event.composing); keyboard.onCompositionChange(event); };
  const publishDesktopSelection: NativeDesktopComposerShortcutPublisher | undefined = platform?.desktop && props.onDesktopShortcuts ? registration => {
    if (registration.type === 'register') desktopSelection.set(registration.owner);
    else if (desktopSelection() === registration.owner) desktopSelection.set(null);
  } : undefined;
  effect(() => { if (!current()) { composing.set(false); composerFocused.set(false); } });
  if (platform?.desktop) effect(() => {
    if (!inputReady() || !editEnabled() || recording() || panel() || composerFocused()) return;
    untracked(() => input?.focus());
  });
  if (platform?.desktop && props.onDesktopShortcuts) {
    const shortcuts = createNativeDesktopComposerShortcutOwner({ current, composing, overlayOpen: () => !!panel() || starterPanel(), actions: {
      focus_input: { get enabled() { return editEnabled() && !recording(); }, run: () => input?.focus() },
      submit_message: { get enabled() { return composerEnabled() && !recording() && !owner.creationUnknown() && !!owner.directory; }, run: () => keyboard.onSubmit() },
      open_model_selector: { get enabled() { return editEnabled() && !recording(); }, run: () => { userIntent(); Keyboard.dismiss(); panel.set('model'); } },
      open_agent_selector: { get enabled() { return editEnabled() && !recording(); }, run: () => { userIntent(); Keyboard.dismiss(); panel.set('agent'); } },
      cycle_agent: { get enabled() { return editEnabled() && !recording() && desktopSelection()?.actions.cycle_agent?.enabled === true; }, run: intent => desktopSelection()?.actions.cycle_agent?.run(intent) },
      cycle_thinking_variant: { get enabled() { return editEnabled() && !recording() && desktopSelection()?.actions.cycle_thinking_variant?.enabled === true; }, run: intent => desktopSelection()?.actions.cycle_thinking_variant?.run(intent) },
      toggle_dictation: { get enabled() { return editEnabled(); }, run: () => dictate() },
      clear_input: { get enabled() { return editEnabled() && !recording(); }, run: () => { userIntent(); owner.setDraftText(''); keyboard.dismiss(); input?.focus(); } },
    } });
    untracked(() => props.onDesktopShortcuts?.({ type: 'register', owner: shortcuts.owner }));
    cleanup(() => { shortcuts.retire(); untracked(() => props.onDesktopShortcuts?.({ type: 'retire', owner: shortcuts.owner })); });
  }
  const modelLabelText = () => {
    const selected = owner.selection().model;
    if (!selected?.id) return t('chat.modelControls.selectModel');
    const provider = modelProviders().find(item => text(item.id) === selected.providerID);
    return getModelDisplayName(provider, selected.id) || selected.id;
  };
  const variantLabelText = () => {
    const variant = owner.selection().model?.variant;
    return variant ? formatEffortLabel(variant) : '';
  };
  const composerPlaceholder = () => {
    const base = t(mode() === 'shell' ? 'chat.chatInput.placeholder.shell' : platform?.desktop ? 'chat.chatInput.placeholder.chat' : 'chat.chatInput.placeholder.chatCompact');
    if (!platform?.desktop || mode() === 'shell' || recording() || !dictationEnabled()) return base;
    const selected = currentLocale();
    const separator = selected.startsWith('zh') ? '\uFF0C' : selected.startsWith('ja') ? '\u3001' : ', ';
    return `${base}${separator}${t('chat.dictation.holdHere')}`;
  };
  if (platform?.desktop) effect(() => {
    const active = current();
    untracked(() => {
      if (!active) return;
      void request('/api/voice/settings').then(value => {
        if (current()) dictationEnabled.set(record(value).dictationEnabled === true);
      }).catch(() => { if (current()) dictationEnabled.set(false); });
    });
  });
  const welcomeTitle = () => owner.project.name ? t('chat.emptyState.draftTitleWithProject', { project: owner.project.name }) : t('chat.emptyState.draftTitle');
  const projectTitleIndex = () => owner.project.name ? welcomeTitle().indexOf(owner.project.name) : -1;
  const submitStarter = (item: StarterItem) => {
    if (!selectionEnabled() || pending() || recording() || attaching()) return;
    userIntent();
    const draft = owner.durable.draft();
    mode.set('normal');
    if (item.ref.type === 'skill') owner.insertReference({ kind: 'skill', value: item.ref.name, label: item.ref.name, scope: owner.durable.scope }, 0, 0);
    else owner.setDraftText(`${item.submitText}${draft.trim() ? `\n${draft}` : ''}`);
    void submit();
  };
  return <NewSessionLayout><>
    <If when={ownership.transferred()} else={<>
      <NewSessionWelcome><>
        <View class="items-center">
          <Text class="text-foreground" style={{ fontSize: 30, lineHeight: 36, fontWeight: '400', letterSpacing: -0.75, textAlign: 'center', maxWidth: platform?.desktop ? 780 : 448 }}><If when={projectTitleIndex() >= 0} else={welcomeTitle()}>{welcomeTitle().slice(0, projectTitleIndex())}<Text style={{ fontWeight: '500' }}>{owner.project.name}</Text>{welcomeTitle().slice(projectTitleIndex() + owner.project.name.length)}</If></Text>
          <If when={!platform?.desktop}><NativeNewSessionStarters owner={owner} active={() => selectionEnabled() && !panel()} visible={() => owner.phase() === 'draft' && keyboardFrame().height === 0} onGestureActiveChange={props.onStarterGestureChange} onSubmit={submitStarter} /></If>
        </View>
        <If when={owner.creationUnknown() && !owner.submitting()}><NewSessionRecovery owner={owner} current={current} pending={pending} perform={perform} /></If>
        <If when={owner.phase() !== 'draft' && !owner.submitting() && !!owner.durable.pendingSend()}><View testID="new-session-captured-input" class="rounded-xl bg-card p-3 gap-2"><Text class="text-xs text-muted-foreground">{newSessionText('capturedInput')}</Text><Text class="text-sm text-foreground">{owner.durable.pendingSend()?.text}</Text><Each of={owner.durable.pendingSend()?.files ?? []}>{file => <Text class="text-xs text-muted-foreground">{file().name}</Text>}</Each></View></If>
        <If when={!!owner.target()}><Text testID="new-session-existing-target" class="text-sm text-muted-foreground">{newSessionText('selectedSession', { id: owner.target()?.id ?? '' })}</Text></If>
        <If when={owner.status() === 'loading' || owner.durable.status() === 'loading'}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If>
        <If when={owner.status() === 'error' || owner.durable.status() === 'error' || !!error()}><View testID="new-session-error" class="gap-2"><Text role="alert" class="text-sm text-destructive">{error() || (owner.durable.status() === 'error' || owner.error() === 'new-session-restore-failed' ? newSessionText('storageFailed') : owner.creationUnknown() ? newSessionText('unknownTitle') : newSessionText('operationFailed'))}</Text><Button testID="new-session-storage-retry" class={action} disabled={!current() || pending() || owner.submitting()} onPress={() => { void perform(owner.retryStorage); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></View></If>
      </></NewSessionWelcome>
      <View class={platform?.desktop ? 'w-full' : 'px-3 pt-2'} style={platform?.desktop ? {} : { paddingBottom: keyboardFrame().height > 0 ? keyboardFrame().height : safeArea().bottom + 16, transitionProperty: 'all', transitionDuration: keyboardFrame().duration }}>
        <If when={!platform?.desktop}><NewSessionProjectButton owner={owner} enabled={selectionEnabled} onPress={() => { userIntent(); Keyboard.dismiss(); panel.set('project'); }} /></If>
        <If when={platform?.desktop}><View testID="desktop-new-session-targets" class="mb-1 flex-row flex-wrap items-center gap-2"><NewSessionProjectButton owner={owner} enabled={selectionEnabled} onPress={() => { userIntent(); panel.set('project'); }} /><NewSessionBranchSelector owner={owner} enabled={selectionEnabled} open={panel() === 'branch'} onOpen={() => { userIntent(); panel.set('branch'); }} onClose={() => panel.set(null)} onChoose={(project, directory) => props.onChangeProject(project, directory)} /></View></If>
        <View testID="new-session-composer-glass" ref={node => anchor.set(node)} onLayout={event => composerWidth.set(event.bounds.size.width)} class={platform?.desktop ? 'relative min-w-0' : 'px-3 pt-1 pb-1'} style={platform?.desktop ? { borderRadius: 24, borderWidth: 1, borderColor: 'transparent', backgroundColor: token('background') } : nativeComposerSurface}>
          <If when={platform?.desktop}><View accessible={false} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 23, pointerEvents: 'none', backgroundColor: token('foreground'), opacity: composerFocused() ? 0.11 : 0.08 }} /></If>
          <If when={platform?.desktop && (attaching() || attachmentFailure())}><View testID="new-session-attachment-status" class="gap-2 py-2"><Text class="text-xs text-muted-foreground">{t('chat.chatInput.actions.addAttachment')}</Text><Text role={attachmentFailure() ? 'alert' : undefined} class={attachmentFailure() ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>{attachmentStatus()?.state === 'unknown' || attachmentStatus()?.state === 'retired' && attachmentStatus()?.uncertain || attachmentStatus()?.orphaned ? t('chat.questionDelegate.uncertain') : attachmentFailure() ? newSessionText('operationFailed') : t('common.loading')}</Text><View class="flex-row gap-2"><Button testID="new-session-attachment-retry" class={action} disabled={!current() || attachmentRefreshing()} onPress={() => { void checkAttachment(); }}><Text class="text-foreground">{t('chat.questionDelegate.refreshStatus')}</Text></Button><Button testID="new-session-attachment-cancel" class={action} disabled={!current() || attachmentRefreshing()} onPress={() => { void checkAttachment(true); }}><Text class="text-foreground">{t('chat.chatInput.actions.attachCancel')}</Text></Button></View></View></If>
          <Each of={owner.durable.attachments()}>{attachment => <View class="flex-row items-center gap-2"><Text class="flex-1 text-sm text-foreground">{attachment().name}</Text><Button testID={`new-session-remove-attachment-${attachment().name}`} class="min-h-10 min-w-10 items-center justify-center" disabled={!current() || owner.submitting()} accessibilityLabel={t('chat.chatInput.actions.attachCancel')} onPress={() => owner.setAttachments(owner.durable.attachments().filter(file => file !== attachment()))}><Icon name="close" size={16} /></Button></View>}</Each>
          <View style={platform?.desktop ? { paddingTop: 4 } : undefined}><Input testID="new-session-composer" ref={composerRef} class={platform?.desktop ? 'text-foreground' : 'min-h-[52px] max-h-36 py-[10px] text-foreground'} style={platform?.desktop ? { ...nativeChatTextStyle('composer'), minHeight: 52, maxHeight: 160, paddingHorizontal: 12, paddingTop: 16, paddingBottom: 8, backgroundColor: 'transparent', borderWidth: 0 } : { ...nativeChatTextStyle('composer'), backgroundColor: 'transparent', borderWidth: 0 }} multiline readonly={recording() || !current()} value={owner.durable.draft()} selectedRange={keyboard.selectedRange()} onFocus={event => { if (platform?.desktop) composerFocused.set(true); keyboard.onFocus(event); }} onBlur={event => { if (platform?.desktop) composerFocused.set(false); keyboard.onBlur(event); }} submitBehavior={platform?.desktop ? 'submit' : keyboard.submitBehavior()} onSubmit={keyboard.onSubmit} onSelectionChange={keyboard.onSelectionChange} onCompositionChange={onCompositionChange} onChange={event => { if (!current()) return; userIntent(); keyboard.beforeChange(); if (!owner.durable.draft() && mode() === 'normal' && event.value.startsWith('!')) { mode.set('shell'); owner.setDraftText(event.value.slice(1)); } else owner.setDraftText(event.value); keyboard.refresh(); }} placeholder={composerPlaceholder()} />
          </View><View class={platform?.desktop ? 'flex-row items-center min-w-0' : 'min-h-10 flex-row items-center gap-1.5'} style={platform?.desktop ? { paddingHorizontal: 10, paddingVertical: 6, gap: 6, minHeight: 36 } : undefined}>
            <Button testID="new-session-attach" class="size-8 rounded-full items-center justify-center active:bg-accent disabled:opacity-40" hitSlop={6} disabled={!current() || attaching() || mode() === 'shell'} accessibilityLabel={t('chat.chatInput.actions.addAttachment')} onPress={() => { void attach(); }}><View style={{ opacity: 0.8 }}><Icon name="attachment-2" size={18} /></View></Button>
            <Button testID="new-session-dictate" class="size-8 rounded-full items-center justify-center active:bg-accent disabled:opacity-40" hitSlop={6} disabled={!current() || owner.submitting()} accessibilityLabel={t('chat.dictation.start')} onPress={() => { void dictate(); }}><View style={{ opacity: recording() ? 1 : 0.8 }}><Icon name={recording() ? 'stop' : 'mic'} size={18} /></View></Button>
            <If when={mode() === 'shell'}><Button testID="new-session-normal-mode" class="min-h-10 px-1" accessibilityLabel={t('settings.common.actions.cancel')} onPress={() => mode.set('normal')}><Text class="text-xs text-foreground">! ×</Text></Button></If>
            <View class="flex-1" />
            <NativeNewSessionAgent owner={owner} active={selectionEnabled} desktop={platform?.desktop} onUserIntent={userIntent} onOpen={() => { userIntent(); Keyboard.dismiss(); panel.set('agent'); }} onError={() => error.set(newSessionText('operationFailed'))} onPendingChange={value => { if (alive) desktopSelectionPending.set(value); }} onProviders={providers => { if (alive) modelProviders.set(providers); }} onDesktopShortcuts={publishDesktopSelection} />
            <Button testID="new-session-model" class="flex-row items-center gap-1 rounded-lg active:bg-accent disabled:opacity-40" style={{ height: platform?.desktop ? 24 : 26, maxWidth: platform?.desktop ? 260 : 144, flexShrink: 1, minWidth: 0 }} hitSlop={6} disabled={!selectionEnabled()} accessibilityLabel={`${modelLabelText()}${variantLabelText() ? ` ${variantLabelText()}` : ''}`} onPress={() => { userIntent(); Keyboard.dismiss(); panel.set('model'); }}><If when={!!owner.selection().model}><NativeModelLogo modelID={owner.selection().model?.id} providerID={owner.selection().model?.providerID} size={16} /></If><Text class="text-foreground" style={{ fontSize: 11, lineHeight: 14, fontWeight: '500', opacity: 0.8, maxWidth: platform?.desktop ? 220 : 96, flexShrink: 1, numberOfLines: 1 }}>{modelLabelText()}</Text><If when={!!variantLabelText()}><Text class="text-muted-foreground" style={{ fontSize: 11, lineHeight: 14, flexShrink: 1, numberOfLines: 1 }}>{variantLabelText()}</Text></If></Button>
            <NativeComposerSend presentation={platform?.desktop ? 'desktop' : 'mobile'} active={current()} hasContent={hasContent()} inFlight={owner.submitting() || !!local && pending()} disabled={!current() || owner.folderChanging() || owner.status() === 'loading' || owner.durable.status() !== 'ready' || pending() || confirmingLocalCommand() || composing() || attaching() || recording() || !owner.directory || !hasContent() && owner.phase() === 'draft' || owner.creationUnknown()} onPress={() => { void submit(); }} />
          </View>
        </View>
        <If when={platform?.desktop}><View class="items-center"><NativeNewSessionStarters owner={owner} desktop active={() => selectionEnabled() && !panel()} visible={() => owner.phase() === 'draft'} onSubmit={submitStarter} onOverlayChange={value => starterPanel.set(value)} /></View></If>
        <If when={!!keyboard.commandTrigger() && !!anchor() && !panel()}><Overlay testID="new-session-command-panel" anchor={anchor()} placement="top" align="start" offset={8} margin={12} style={{ width: platform?.desktop ? Math.min(composerWidth() || 780, windowSize().width - 48) : windowSize().width - 24 }} onPressOutside={keyboard.dismiss} onCancel={keyboard.dismiss}><NativeCommandSuggestions scope={owner.durable.scope} keyboard={keyboard} commands={commands()} loadCommands={loadCommands} catalog={local?.catalog} /></Overlay></If>
        <If when={!!keyboard.trigger() && !!anchor() && !panel()}><Overlay testID="new-session-reference-panel" anchor={anchor()} placement="top" align="start" offset={8} margin={12} style={{ width: platform?.desktop ? Math.min(composerWidth() || 780, windowSize().width - 48) : windowSize().width - 24 }} onPressOutside={keyboard.dismiss} onCancel={keyboard.dismiss}><NativeReferencePicker scope={owner.durable.scope} keyboard={keyboard} open query={keyboard.trigger()?.query} request={request} onClose={keyboard.dismiss} /></Overlay></If>
      </View>
    </>}><View testID="new-session-transferred" class="p-5 gap-3"><Text class="text-sm text-muted-foreground">{newSessionText('handedOff')}</Text></View></If>
    <NativeNewSessionModal value={panel() === 'branch' ? null : panel()} active={selectionEnabled} onClose={() => panel.set(null)} onDismiss={value => {
      if (value !== 'project') return;
      const choice = pendingProject; pendingProject = undefined;
      if (choice && selectionEnabled() && !panel()) void props.onChangeProject(choice.project, choice.directory);
    }} height={pickerSheetHeight(windowSize().height, safeArea())}>{(value, active, close, sheet) => <>
      <If when={value === 'model' || value === 'agent'}><View class="flex-1" style={{ paddingBottom: safeArea().bottom }}><NativeNewSessionModels owner={owner} mode={value === 'agent' ? 'agent' : 'model'} active={active} onDone={close} sheet={sheet} /></View></If>
      <If when={value === 'project'}><NewSessionProjects owner={owner} projects={props.projects} current={active} onChoose={async (project, directory) => { if (active()) { pendingProject = { project, directory }; close(); } }} /></If>
    </>}</NativeNewSessionModal>
  </></NewSessionLayout>;
}

function NewSessionProjectButton(props: { owner: Ownership['owner']; enabled: () => boolean; onPress: () => void }) {
  return <View class={platform?.desktop ? '' : 'mb-1.5 px-0.5 flex-row items-center gap-1.5'}><Button testID="new-session-project" class="h-[26px] px-1.5 flex-row items-center gap-1.5 rounded-lg hover:bg-accent active:bg-accent disabled:opacity-40" style={{ maxWidth: platform?.desktop ? 360 : '46%' }} hitSlop={8} disabled={!props.enabled()} accessibilityLabel={`${props.owner.project.name || t('sessions.scheduledTasks.dialog.error.chooseProjectFirst')}${props.owner.directory ? ` ${props.owner.directory}` : ''}`} onPress={props.onPress}><View style={{ opacity: 0.8 }}><Icon name="folder" size={14} /></View><Text class="text-foreground" style={{ fontSize: platform?.desktop ? 12 : 11, lineHeight: platform?.desktop ? 16 : 14, fontWeight: '500', opacity: 0.8, flexShrink: 1, numberOfLines: 1 }}>{props.owner.project.name || t('sessions.scheduledTasks.dialog.error.chooseProjectFirst')}</Text><If when={platform?.desktop}><Icon name="arrow-down-s" size={12} /></If></Button></View>;
}

function NewSessionBranchSelector(props: { owner: Ownership['owner']; enabled: () => boolean; open: boolean; onOpen: () => void; onClose: () => void; onChoose: (project: Project, directory: string) => Promise<void> }) {
  const repository = signal<boolean | undefined>(undefined), branch = signal(''), options = signal<Array<{ path: string; label: string }>>([]), busy = signal(false), error = signal(''), search = signal('');
  let alive = true, wasActive = false, revision = 0, pendingPath: string | undefined;
  const current = () => alive && props.enabled() && props.owner.current();
  const root = props.owner.project.path || props.owner.directory;
  async function load() {
    if (!current() || busy() || !root) return;
    const operation = props.owner.captureOperation(), ticket = ++revision;
    const valid = () => current() && operation.current() && ticket === revision;
    busy.set(true); error.set('');
    try {
      const check = record(await operation.request(`/api/git/check?directory=${encodeURIComponent(root)}`));
      if (!valid()) return;
      if (typeof check.isGitRepository !== 'boolean') throw new Error('invalid-repository');
      repository.set(check.isGitRepository);
      if (!check.isGitRepository) { branch.set(''); options.set([]); return; }
      const results = await Promise.allSettled([
        operation.request(`/api/git/branches?directory=${encodeURIComponent(root)}`),
        operation.request(`/api/git/worktrees?directory=${encodeURIComponent(root)}`),
        props.owner.directory === root ? Promise.resolve(null) : operation.request(`/api/git/branches?directory=${encodeURIComponent(props.owner.directory)}`),
      ]);
      if (!valid()) return;
      const roots = results[0], trees = results[1], selected = results[2];
      let next = options();
      if (roots.status === 'fulfilled' && typeof record(roots.value).current === 'string') {
        const label = text(record(roots.value).current);
        next = [...(label ? [{ path: root, label }] : []), ...next.filter(row => row.path !== root)];
        if (props.owner.directory === root) branch.set(label);
      } else error.set(t('common.unavailable'));
      if (trees.status === 'fulfilled' && Array.isArray(trees.value)) {
        const rows = trees.value.map(record);
        if (rows.some(row => typeof row.path !== 'string' || typeof row.branch !== 'string')) error.set(t('common.unavailable'));
        else next = [...next.filter(row => row.path === root), ...rows.filter(row => row.path !== root && !!text(row.branch)).map(row => ({ path: text(row.path), label: text(row.branch) }))];
      } else error.set(t('common.unavailable'));
      options.set(next);
      if (props.owner.directory !== root) {
        if (selected.status === 'fulfilled' && typeof record(selected.value).current === 'string') branch.set(text(record(selected.value).current));
        else error.set(t('common.unavailable'));
      }
    } catch { if (valid()) error.set(t('common.unavailable')); }
    finally { if (alive && ticket === revision) busy.set(false); }
  }
  effect(() => { const active = current(); untracked(() => { if (!active) { wasActive = false; revision++; busy.set(false); } else if (!wasActive) { wasActive = true; void load(); } }); });
  cleanup(() => { alive = false; revision++; });
  return <>
    <If when={repository() !== false}><Button testID="desktop-new-session-branch" class="h-[26px] px-1.5 flex-row items-center gap-1.5 rounded-lg hover:bg-accent active:bg-accent disabled:opacity-40" style={{ maxWidth: 360 }} disabled={!current()} accessibilityLabel={t('session.newWorktree.selectBranch')} onPress={() => { if (!current()) return; search.set(''); props.onOpen(); void load(); }}><Icon name="git-branch" size={14} color={token('muted-foreground')} /><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1, flexShrink: 1 }}>{branch() || t(busy() ? 'common.loading' : 'session.newWorktree.selectBranch')}</Text><Icon name="arrow-down-s" size={12} /></Button></If>
    <If when={!!error() && !props.open}><Button testID="desktop-new-session-branch-retry" class="h-7 px-2 rounded-lg hover:bg-accent" disabled={!current() || busy()} onPress={() => { void load(); }}><Text class="text-xs text-destructive">{t('chat.questionDelegate.retry')}</Text></Button></If>
    <NativeNewSessionModal value={props.open ? 'branch' : null} active={current} onClose={props.onClose} onDismiss={() => { const path = pendingPath; pendingPath = undefined; if (path && current()) void props.onChoose(props.owner.project, path); }} height={0}>{(_value, active, close) => <View class="flex-1 gap-3 p-2"><Text class="text-sm text-foreground font-semibold">{t('session.newWorktree.selectBranch')}</Text><Input testID="desktop-new-session-branch-search" class="min-h-9 px-2 rounded-lg bg-card text-foreground" value={search()} readonly={!active()} placeholder={t('branchPickerDialog.search.placeholder')} onChange={event => { if (active()) search.set(event.value); }} /><If when={busy()}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If><If when={!!error()}><Text role="alert" class="text-sm text-destructive">{error()}</Text><Button class={action} disabled={!active() || busy()} onPress={() => { void load(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If><Scroll class="flex-1" contentClass="gap-1"><Each of={options().filter(row => `${row.label} ${row.path}`.toLocaleLowerCase().includes(search().trim().toLocaleLowerCase()))}>{row => <Button testID={`desktop-new-session-branch-${row().path}`} class="min-h-10 rounded-lg px-2 py-2 flex-row items-center gap-2 hover:bg-accent active:bg-accent" disabled={!active()} selected={row().path === props.owner.directory} onPress={() => { if (!active()) return; if (row().path !== props.owner.directory) pendingPath = row().path; close(); }}><View class="flex-1 gap-1"><Text class="text-sm text-foreground">{row().label}</Text><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{row().path}</Text></View><If when={row().path === props.owner.directory}><Icon name="check" size={14} /></If></Button>}</Each><If when={!busy() && !error() && !options().length}><Text class="text-sm text-muted-foreground">{t('branchPickerDialog.state.noBranchesFound')}</Text></If></Scroll></View>}</NativeNewSessionModal>
  </>;
}

function NativeNewSessionAgent(props: { owner: Ownership['owner']; active: () => boolean; desktop?: boolean; onOpen: () => void; onError: () => void; onDesktopShortcuts?: NativeDesktopComposerShortcutPublisher; onPendingChange?: (pending: boolean) => void; onProviders?: (providers: Row[]) => void; onUserIntent?: () => void }) {
  const request = captureHostRequest();
  let alive = true, wasActive = false, selectionMutation = 0, labelTimer: ReturnType<typeof setTimeout> | undefined, origin: { x: number; y: number } | undefined;
  const current = () => alive && props.active() && props.owner.current();
  const catalog = createNewSessionCatalog(props.owner.directory, () => alive && props.owner.current(), request), pending = signal(false), labelVisible = signal(false);
  const primaryAgents = computed(() => catalog.agents().map(agent => ({ name: text(agent.name), mode: agent.mode === 'primary' ? 'primary' as const : agent.mode === 'all' ? 'all' as const : undefined })));
  const nextVariant = computed(() => { const model = props.owner.selection().model; return model ? nativeDesktopNextModelVariant(catalog.providers(), model) : undefined; });
  async function load() { await catalog.load('agent'); if (current() && !catalog.error()) await catalog.load('model'); }
  async function cycle(direction: -1 | 1 = 1) {
    if (!current() || pending()) return;
    props.onUserIntent?.();
    const captured = props.owner.captureOperation();
    const ticket = ++selectionMutation;
    pending.set(true);
    try {
      if (!catalog.resolved() || catalog.error()) await load();
      if (!current() || !captured.current() || ticket !== selectionMutation) return;
      if (catalog.error()) throw new Error('catalog-unavailable');
      const previous = props.owner.selection().agent, next = getCycledPrimaryAgentName(primaryAgents(), previous, direction);
      if (!next) return;
      await props.owner.select(agentDraftSelection(props.owner.selection(), next, catalog.agents(), catalog.providers()));
      if (!current() || !captured.current() || ticket !== selectionMutation || !previous || previous === next) return;
      if (labelTimer) clearTimeout(labelTimer);
      labelVisible.set(true); labelTimer = setTimeout(() => { labelTimer = undefined; if (alive) labelVisible.set(false); }, 1000);
    } catch { if (current() && captured.current() && ticket === selectionMutation) props.onError(); }
    finally { if (alive && ticket === selectionMutation) pending.set(false); }
  }
  const press = createAgentPress({ enabled: () => current() && !pending(), cycle: () => { void cycle(); }, open: props.onOpen, schedule: work => setTimeout(work, LONG_PRESS_MS), cancelTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) });
  async function cycleVariant() {
    if (!current() || pending()) return;
    props.onUserIntent?.();
    const captured = props.owner.captureOperation();
    const ticket = ++selectionMutation;
    pending.set(true);
    try {
      if (!catalog.resolved() || catalog.error()) await load();
      if (!current() || !captured.current() || ticket !== selectionMutation) return;
      if (catalog.error()) throw new Error('catalog-unavailable');
      const selection = props.owner.selection(), model = selection.model;
      if (!model) return;
      const variant = nativeDesktopNextModelVariant(catalog.providers(), model);
      if (variant !== undefined) await props.owner.select({ ...selection, model: { ...model, variant } });
    } catch { if (current() && captured.current() && ticket === selectionMutation) props.onError(); }
    finally { if (alive && ticket === selectionMutation) pending.set(false); }
  }
  if (platform?.desktop && props.onDesktopShortcuts) {
    const shortcuts = createNativeDesktopComposerShortcutOwner({ current, composing: () => false, overlayOpen: () => false, actions: {
      cycle_agent: { get enabled() { return !pending() && !catalog.busy() && (!catalog.resolved() || primaryAgents().length > 1); }, run: intent => cycle(intent?.direction ?? 1) },
      cycle_thinking_variant: { get enabled() { return !pending() && !catalog.busy() && nextVariant() !== undefined; }, run: cycleVariant },
    } });
    untracked(() => props.onDesktopShortcuts?.({ type: 'register', owner: shortcuts.owner }));
    cleanup(() => { shortcuts.retire(); untracked(() => props.onDesktopShortcuts?.({ type: 'retire', owner: shortcuts.owner })); });
    effect(() => { const value = pending(); untracked(() => props.onPendingChange?.(value)); });
  }
  effect(() => {
    const providers = catalog.providers();
    if (!alive) return;
    untracked(() => { if (alive) props.onProviders?.(providers); });
  });
  effect(() => { if (!props.active()) { if (props.desktop) { selectionMutation++; pending.set(false); } wasActive = false; press.cancel(); labelVisible.set(false); if (labelTimer) clearTimeout(labelTimer); labelTimer = undefined; } else if (!wasActive) { wasActive = true; void load(); } });
  cleanup(() => { alive = false; press.cancel(); catalog.dispose(); if (labelTimer) clearTimeout(labelTimer); });
  return <View class="flex-row items-center" onTouchStartCapture={event => { origin = { x: event.pageX, y: event.pageY }; }} onTouchMoveCapture={event => { if (event.touches.length > 1 || origin && Math.hypot(event.pageX - origin.x, event.pageY - origin.y) > LONG_PRESS_MOVE_PX) press.cancel(); }} onTouchCancel={press.cancel} onMouseLeave={press.cancel}>
    <Button testID="new-session-agent" class="rounded-lg flex-row items-center hover:bg-accent active:bg-accent disabled:opacity-40" style={{ height: props.desktop ? 24 : 26 }} hitSlop={6} disabled={!props.active() || pending()} accessibilityLabel={props.owner.selection().agent ? getAgentDisplayName(primaryAgents(), props.owner.selection().agent) : t('chat.modelControls.selectAgent')} onPressDown={() => { if (!props.desktop) press.down(); }} onPressUp={() => { if (!props.desktop) press.up(); }} onPress={() => { if (props.desktop) { if (current() && !pending()) props.onOpen(); } else press.press(); }}>
      <View class="items-center justify-center" style={{ width: 24, height: props.desktop ? 24 : 26 }}><If when={!!props.owner.selection().agent} else={<Icon name="user" size={props.desktop ? 20 : 16} />}><NativeAgentAvatar name={props.owner.selection().agent} size={props.desktop ? 20 : 16} /></If></View>
      <View accessibilityElementsHidden={!labelVisible()} style={{ maxWidth: labelVisible() ? 160 : 0, opacity: labelVisible() ? 1 : 0, overflow: 'hidden', transitionProperty: 'all', transitionDuration: 280, transitionTimingFunction: 'ease-in-out' }}><Text class="pl-1 pr-0.5 text-xs" style={{ color: nativeAgentAccent(props.owner.selection().agent), numberOfLines: 1 }}>{props.owner.selection().agent ? getAgentDisplayName(primaryAgents(), props.owner.selection().agent) : t('chat.modelControls.selectAgent')}</Text></View>
    </Button>
  </View>;
}

function NativeNewSessionStarters(props: { owner: Ownership['owner']; active: () => boolean; visible: () => boolean; desktop?: boolean; onSubmit: (item: StarterItem) => void; onGestureActiveChange?: (active: boolean) => void; onOverlayChange?: (open: boolean) => void }) {
  const request = captureHostRequest();
  const global = signal<DraftStarterRef[]>([]), project = signal<DraftStarterRef[]>([]), commands = signal<Row[]>([]), skills = signal<Row[]>([]);
  const globalReady = signal(false), projectReady = signal(false), loading = signal(false), catalogBusy = signal(false), saving = signal(false), error = signal('');
  const open = signal(false), search = signal(''), expanded = signal(false), overflow = signal(false);
  if (props.desktop) {
    effect(() => { const value = open(); untracked(() => props.onOverlayChange?.(value)); });
    cleanup(() => props.onOverlayChange?.(false));
  }
  const drag = signal<{ id: string; dx: number; dy: number; over: string | null; rects: StarterRect[]; hidden: Set<string>; shifts: Map<string, { x: number; y: number }> } | null>(null);
  const refs = new Map<string, ViewRef>();
  const rowOffsets = signal<ReadonlyMap<string, number>>(new Map());
  const hoveredChip = signal<string | null>(null);
  let alive = true, wasActive = false, timer: ReturnType<typeof setTimeout> | undefined, gesture = 0, suppressed = false, origin: { x: number; y: number } | undefined;
  let layout: { width: number; height: number } | undefined;
  let touchActive = false, pressedID: string | undefined, measuredItems: StarterItem[] | undefined;
  let pointerItem: StarterItem | undefined, pointerStarted = false, pointerFinishing = false;
  let pointerDelta = { x: 0, y: 0 }, pointerActivation: Promise<void> | undefined;
  const current = () => alive && props.active() && props.owner.current();
  const chipsActive = () => current() && props.visible() && !open();
  const hasProject = !!props.owner.project.id && !!props.owner.project.path;
  const items = computed(() => [...resolveStarters(global(), 'global', commands(), skills(), t), ...resolveStarters(project(), 'project', commands(), skills(), t)]);
  const options = computed(() => starterOptions(global(), project(), commands(), skills(), t).filter(item => (item.group !== 'project' || hasProject) && `${item.label} ${item.ref.name}`.toLocaleLowerCase().includes(search().trim().toLocaleLowerCase())));
  const hiddenChip = (id: string) => !expanded() && (drag()?.hidden.has(id) === true || (rowOffsets().get(id) ?? 0) >= 28);
  function chipLayout(id: string, y: number) {
    if (!Number.isFinite(y) || rowOffsets().get(id) === y) return;
    if (origin) { suppressed = true; cancelDrag(); }
    const next = new Map(rowOffsets()); next.set(id, y); rowOffsets.set(next);
  }
  async function send(path: string, method?: string, body?: unknown) {
    if (!current()) throw new Error('new-session-stale-starters');
    const result = await request(path, method, body);
    if (!current()) throw new Error('new-session-stale-starters');
    return result;
  }
  async function projectConfig() {
    const home = record(await send('/api/fs/home'));
    const location = projectStarterLocation(text(home.home), props.owner.project.path);
    const raw = await send(`/api/fs/read?path=${encodeURIComponent(location.path)}&optional=true`);
    const config = projectStarterConfig(raw);
    if (typeof raw === 'string' && !raw.trim()) return { location, config: projectStarterConfig(await send(`/api/fs/read?path=${encodeURIComponent(location.legacy)}&optional=true`)) };
    return { location, config };
  }
  async function loadCatalog() {
    if (!current() || catalogBusy()) return;
    catalogBusy.set(true);
    const directory = encodeURIComponent(props.owner.directory);
    const results = await Promise.allSettled([send(`/api/config/commands/metadata?directory=${directory}`, 'POST', { catalog: true }), send(`/api/config/skills?summary=true&directory=${directory}`)]);
    if (!current()) { if (alive) catalogBusy.set(false); return; }
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') { error.set(t('common.unavailable')); continue; }
      const rows = record(result.value)[index === 0 ? 'commands' : 'skills'];
      if (!Array.isArray(rows)) { error.set(t('common.unavailable')); continue; }
      (index === 0 ? commands : skills).set(rows.map(record));
    }
    catalogBusy.set(false);
  }
  async function load() {
    if (!current() || loading()) return;
    loading.set(true); error.set('');
    const results = await Promise.allSettled([send('/api/config/settings'), hasProject ? projectConfig() : Promise.resolve(null)]);
    if (!current()) { if (alive) loading.set(false); return; }
    const shared = results[0], scoped = results[1];
    if (shared.status === 'fulfilled' && pickerPreferences(shared.value)) { global.set(globalStarterRefs(record(shared.value))); globalReady.set(true); }
    else error.set(t('common.unavailable'));
    if (scoped.status === 'fulfilled') { project.set(scoped.value ? sanitizeStarterRefs(scoped.value.config.draftStarters) : []); projectReady.set(true); }
    else error.set(t('common.unavailable'));
    loading.set(false);
    if ([...global(), ...project()].some(ref => ref.type === 'skill' || !getBuiltInStarter(ref.name))) await loadCatalog();
  }
  async function persist(group: StarterGroup, update: (previous: DraftStarterRef[]) => DraftStarterRef[], active: () => boolean = current) {
    if (!current() || !active() || saving() || !(group === 'global' ? globalReady() : projectReady())) return;
    saving.set(true); error.set('');
    try {
      if (group === 'global') {
        const settings = pickerPreferences(await send('/api/config/settings'));
        if (!active()) return;
        if (!settings) throw new Error('invalid-settings');
        const next = update(globalStarterRefs(settings));
        const result = record(await send('/api/config/settings', 'PUT', { draftStarters: next }));
        if (result.ok === false || result.success === false) throw new Error('save-failed');
        global.set(next);
      } else {
        if (!hasProject) return;
        const { location, config } = await projectConfig(), next = update(sanitizeStarterRefs(config.draftStarters));
        if (!active()) return;
        const made = record(await send('/api/fs/mkdir', 'POST', { path: location.directory }));
        if (!active()) return;
        if (made.success !== true) throw new Error('mkdir-failed');
        const result = record(await send('/api/fs/write', 'POST', { path: location.path, content: JSON.stringify({ ...config, draftStarters: next, projectPath: location.root }, null, 2) }));
        if (result.success !== true) throw new Error('save-failed');
        project.set(next);
      }
      if (current() && active()) open.set(false);
    } catch { if (current() && active()) error.set(t('common.unavailable')); }
    finally { if (alive) saving.set(false); }
  }
  function cancelDrag() { const held = !!origin; gesture++; if (timer) clearTimeout(timer); timer = undefined; origin = undefined; pointerItem = undefined; pointerStarted = false; pointerFinishing = false; pointerActivation = undefined; drag.set(null); if (held) props.onGestureActiveChange?.(false); }
  async function beginDrag(item: StarterItem, ticket: number) {
    const measured = await Promise.all([...items().map(item => item.id), ...(props.desktop ? [] : [STARTER_TRASH])].map(async id => { const size = await refs.get(id)?.measure(); return size ? { id, x: size.pagePosition.x, y: size.pagePosition.y, width: size.bounds.size.width, height: size.bounds.size.height } : null; }));
    if (!chipsActive() || ticket !== gesture || !origin) { if (ticket === gesture) cancelDrag(); return; }
    const rects = measured.filter((rect): rect is StarterRect => !!rect), own = rects.find(rect => rect.id === item.id);
    if (!own) { cancelDrag(); return; }
    const firstRow = Math.min(...rects.filter(rect => rect.id !== STARTER_TRASH).map(rect => rect.y));
    const hidden = new Set(!expanded() ? rects.filter(rect => rect.id !== STARTER_TRASH && rect.y >= firstRow + 28).map(rect => rect.id) : []);
    if (hidden.has(item.id)) { cancelDrag(); return; }
    suppressed = true; drag.set({ id: item.id, dx: 0, dy: 0, over: item.id, rects: rects.filter(rect => !hidden.has(rect.id)), hidden, shifts: new Map() });
  }
  function startDrag(item: StarterItem, x: number, y: number) {
    cancelDrag(); touchActive = true; pressedID = item.id; suppressed = true;
    if (!chipsActive() || saving() || hiddenChip(item.id)) return;
    suppressed = false;
    origin = { x, y }; props.onGestureActiveChange?.(true); const ticket = gesture;
    if (props.desktop) { pointerItem = item; pointerDelta = { x: 0, y: 0 }; return; }
    timer = setTimeout(() => { timer = undefined; suppressed = true; void beginDrag(item, ticket).catch(() => { if (ticket === gesture) cancelDrag(); }); }, 200);
  }
  function moveDrag(x: number, y: number, fingers: number) {
    if (!origin) return;
    if (fingers > 1) { suppressed = true; cancelDrag(); return; }
    const dx = x - origin.x, dy = y - origin.y, active = drag();
    if (!active) { if (Math.hypot(dx, dy) > 6) { suppressed = true; cancelDrag(); } return; }
    const own = active.rects.find(rect => rect.id === active.id)!;
    const over = closestStarter(active.rects, own, dx, dy);
    drag.set({ ...active, dx, dy, over, shifts: over === active.over ? active.shifts : starterShifts(active.id, over, active.rects) });
  }
  function movePointer(x: number, y: number, button: string | null) {
    if (!props.desktop || !origin || pointerFinishing) return;
    if (!chipsActive() || button !== 'left') { suppressed = true; touchActive = false; cancelDrag(); return; }
    pointerDelta = { x: x - origin.x, y: y - origin.y };
    if (!pointerStarted && Math.hypot(pointerDelta.x, pointerDelta.y) > 8 && pointerItem) {
      const ticket = gesture;
      pointerStarted = true; suppressed = true;
      pointerActivation = beginDrag(pointerItem, ticket).then(() => {
        if (ticket === gesture && origin) moveDrag(origin.x + pointerDelta.x, origin.y + pointerDelta.y, 1);
      }).catch(() => { if (ticket === gesture) cancelDrag(); });
    } else if (drag()) moveDrag(x, y, 1);
  }
  async function endPointer(delta: { x: number; y: number }, cancelled = false) {
    if (!props.desktop || !origin || pointerFinishing) return;
    if (cancelled || !chipsActive()) { touchActive = false; suppressed = true; cancelDrag(); return; }
    movePointer(origin.x + delta.x, origin.y + delta.y, 'left');
    if (!pointerStarted) { touchActive = false; cancelDrag(); return; }
    const ticket = gesture;
    pointerFinishing = true; suppressed = true;
    await pointerActivation;
    if (ticket !== gesture || !origin) return;
    if (!chipsActive()) { touchActive = false; suppressed = true; cancelDrag(); return; }
    moveDrag(origin.x + delta.x, origin.y + delta.y, 1);
    finishDrag();
  }
  function finishDrag() {
    touchActive = false;
    const active = drag(); cancelDrag();
    if (!active || !chipsActive()) return;
    suppressed = true;
    const item = items().find(item => item.id === active.id);
    if (!item || !active.over) return;
    if (active.over === STARTER_TRASH) void persist(item.group, refs => refs.filter(ref => starterKey(ref) !== starterKey(item.ref)), chipsActive);
    else if (active.over !== active.id && active.over.startsWith(`${item.group}:`)) void persist(item.group, refs => moveStarter(refs, item.group, active.id, active.over!), chipsActive);
  }
  function layoutChips(next: { width: number; height: number }) {
    if (layout && (next.width !== layout.width || next.height !== layout.height) && origin) { suppressed = true; cancelDrag(); }
    layout = { width: next.width, height: next.height };
    const more = next.height > 32; overflow.set(more); if (!more && expanded()) expanded.set(false);
  }
  function pressStarter(item: StarterItem) {
    if (suppressed || !chipsActive() || saving() || hiddenChip(item.id) || pressedID && pressedID !== item.id) return;
    const currentItem = items().find(next => next.id === item.id);
    if (!currentItem) return;
    suppressed = true; props.onSubmit(currentItem);
  }
  function removeStarter(item: StarterItem) {
    if (!props.desktop || !chipsActive() || saving() || hiddenChip(item.id)) return;
    suppressed = true; touchActive = false; cancelDrag();
    void persist(item.group, refs => refs.filter(ref => starterKey(ref) !== starterKey(item.ref)), chipsActive);
  }
  const translation = (id: string) => { const active = drag(); return !active ? { x: 0, y: 0 } : active.id === id ? { x: active.dx, y: active.dy } : active.shifts.get(id) ?? { x: 0, y: 0 }; };
  effect(() => {
    const next = items();
    untracked(() => {
      if (measuredItems && measuredItems !== next && origin) { suppressed = true; cancelDrag(); }
      measuredItems = next;
      const retained = new Set(next.map(item => item.id));
      for (const id of refs.keys()) if (id !== STARTER_TRASH && !retained.has(id)) refs.delete(id);
      if ([...rowOffsets().keys()].some(id => !retained.has(id))) rowOffsets.set(new Map([...rowOffsets()].filter(([id]) => retained.has(id))));
    });
  });
  effect(() => {
    const active = props.active(), enabled = chipsActive();
    untracked(() => { if (!active) { wasActive = false; open.set(false); } else if (!wasActive) { wasActive = true; void load(); } if (!enabled) { suppressed = true; hoveredChip.set(null); cancelDrag(); } });
  });
  cleanup(() => { alive = false; suppressed = true; cancelDrag(); refs.clear(); });
  return <>
    <If when={props.visible()}><View class={props.desktop ? 'mt-4 w-full gap-2' : 'mt-8 w-full gap-2'} style={{ maxWidth: props.desktop ? 780 : 448 }}>
      <View class="flex-row items-start gap-0.5">
        <View class="flex-1" style={{ maxHeight: expanded() ? undefined : 28, overflow: expanded() || !!drag() ? 'visible' : 'hidden' }}><View class="flex-row flex-wrap items-center justify-center gap-0.5" onLayout={event => layoutChips(event.bounds.size)} onMouseMove={event => movePointer(event.pagePosition.x, event.pagePosition.y, event.pressedButton)}><Each of={items()}>{item => <View ref={ref => refs.set(item().id, ref)} onLayout={event => chipLayout(item().id, event.bounds.origin.y)} accessibilityElementsHidden={hiddenChip(item().id)} style={{ zIndex: drag()?.id === item().id ? 10 : 0, opacity: hiddenChip(item().id) ? 0 : drag()?.id === item().id ? 0.6 : 1, pointerEvents: hiddenChip(item().id) ? 'none' : 'auto', transform: [{ translateX: translation(item().id).x }, { translateY: translation(item().id).y }], transitionProperty: 'transform', transitionDuration: drag()?.id === item().id ? 0 : 200, transitionTimingFunction: 'ease' }} onTouchStartCapture={event => { if (event.touches.length > 1) { touchActive = true; pressedID = undefined; suppressed = true; cancelDrag(); } else startDrag(item(), event.pageX, event.pageY); }} onTouchMoveCapture={event => { if (!props.desktop) moveDrag(event.pageX, event.pageY, event.touches.length); else if (event.touches.length > 1) { suppressed = true; cancelDrag(); } }} onTouchEndCapture={event => { if (props.desktop) { if (origin) void endPointer({ x: event.pageX - origin.x, y: event.pageY - origin.y }); } else finishDrag(); }} onTouchCancel={() => { touchActive = false; suppressed = true; cancelDrag(); }} onPanEnd={props.desktop ? event => { void endPointer(event.translation, event.cancelled); } : undefined} onMoveShouldSetResponderCapture={() => !props.desktop && !!drag()} onResponderGrant={() => true} onResponderMove={event => { if (!props.desktop) moveDrag(event.pageX, event.pageY, event.touches.length); }} onResponderRelease={() => { if (!props.desktop) finishDrag(); }} onResponderTerminate={() => { touchActive = false; suppressed = true; cancelDrag(); }} onResponderTerminationRequest={() => !drag()} onBlur={() => { suppressed = true; cancelDrag(); }}>
          <View class="flex-row" onMouseEnter={() => { if (props.desktop && chipsActive()) hoveredChip.set(item().id); }} onMouseLeave={() => { if (hoveredChip() === item().id) hoveredChip.set(null); }}>
            <Button testID={`new-session-preset-${item().submitText.startsWith('/') ? item().submitText.slice(1) : `skill-${item().ref.name}`}`} class={`h-7 px-2 flex-row items-center gap-1 rounded-md hover:bg-secondary active:bg-accent disabled:opacity-40 ${props.desktop ? 'pr-5' : ''}`} disabled={!chipsActive() || saving() || hiddenChip(item().id)} onPressDown={() => { if (!touchActive && chipsActive() && !saving() && !hiddenChip(item().id)) { pressedID = item().id; suppressed = false; } }} onPress={() => pressStarter(item())}><View style={{ opacity: 0.6 }}><Icon name={item().icon} size={12} color={token('muted-foreground')} /></View><Text class="text-xs text-muted-foreground">{item().label}</Text></Button>
            <If when={props.desktop && hoveredChip() === item().id && !drag()}><Button testID={`new-session-preset-remove-${item().id}`} accessibilityLabel={t('chat.draftStarters.remove')} class="rounded items-center justify-center hover:bg-secondary active:bg-accent" style={{ position: 'absolute', right: 2, top: 6, width: 16, height: 16 }} disabled={!chipsActive() || saving() || hiddenChip(item().id)} onPressDown={() => { suppressed = true; cancelDrag(); }} onPress={() => removeStarter(item())}><Icon name="close" size={10} /></Button></If>
          </View>
        </View>}</Each></View></View>
        <If when={overflow() || expanded()}><Button testID="new-session-presets-expand" class="size-6 rounded-md items-center justify-center active:bg-accent" hitSlop={6} accessibilityLabel={t(expanded() ? 'chat.draftStarters.collapse' : 'chat.draftStarters.expand')} onPress={() => { if (!chipsActive() || saving()) return; if (touchActive) suppressed = true; cancelDrag(); expanded.set(!expanded()); }}><Icon name={expanded() ? 'arrow-up-s' : 'arrow-down-s'} size={14} /></Button></If>
        <View ref={ref => refs.set(STARTER_TRASH, ref)}><If when={!props.desktop && !!drag()} else={<Button testID="new-session-presets-add" class="size-6 rounded-md items-center justify-center active:bg-accent disabled:opacity-40" hitSlop={6} disabled={!props.active() || loading() || saving() || !globalReady() || !projectReady()} accessibilityLabel={t('chat.draftStarters.add')} onPress={() => { if (!chipsActive() || loading() || saving() || !globalReady() || !projectReady()) return; suppressed = true; cancelDrag(); Keyboard.dismiss(); search.set(''); open.set(true); error.set(''); void loadCatalog(); }}><Icon name="add" size={14} color={token('muted-foreground')} /></Button>}><View testID="new-session-presets-trash" accessibilityLabel={t('chat.draftStarters.remove')} class="size-6 items-center justify-center rounded-md"><Icon name="delete-bin" size={14} color={token(drag()?.over === STARTER_TRASH ? 'destructive' : 'muted-foreground')} /></View></If></View>
      </View>
      <If when={loading()}><Text class="text-xs text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!!error() && !open()}><Text role="alert" class="text-xs text-destructive">{error()}</Text><Button testID="new-session-presets-retry" class={action} disabled={loading() || saving()} onPress={() => { void load(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
    </View></If>
    <NativeNewSessionModal value={open() ? 'presets' : null} active={current} onClose={() => open.set(false)} height={pickerSheetHeight(windowSize().height, safeArea())}>{(_value, active) => <View class="flex-1 p-4 gap-2" style={{ paddingBottom: safeArea().bottom }}><Text class="text-base text-foreground font-semibold">{t('chat.draftStarters.add')}</Text><Input testID="new-session-presets-search" class="min-h-9 rounded-xl bg-card px-3 text-foreground" value={search()} readonly={!active()} onChange={event => { if (active()) search.set(event.value); }} placeholder={t('chat.draftStarters.searchPlaceholder')} accessibilityLabel={t('chat.draftStarters.searchPlaceholder')} /><NativeNewSessionInputAX field="presets" label={t('chat.draftStarters.searchPlaceholder')} />
      <If when={catalogBusy()}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If><If when={!!error()}><Text role="alert" class="text-sm text-destructive">{error()}</Text><Button testID="new-session-presets-catalog-retry" class={action} disabled={!active() || catalogBusy() || saving()} onPress={() => { if (active()) { error.set(''); void loadCatalog(); } }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
      <Scroll class="flex-1" contentClass="gap-2"><Each of={['built-in', 'command', 'skill'] as const}>{section => <If when={options().some(item => item.section === section())}><View class="gap-1"><Text class="text-xs text-muted-foreground">{t(section() === 'built-in' ? 'chat.draftStarters.sectionBuiltIn' : section() === 'command' ? 'chat.draftStarters.sectionCommands' : 'chat.draftStarters.sectionSkills')}</Text><Each of={options().filter(item => item.section === section())}>{item => <Button testID={`new-session-pin-${item().ref.type}-${item().ref.name}`} class="min-h-11 px-2 rounded-lg active:bg-accent disabled:opacity-40" disabled={!active() || saving()} onPress={() => { const selected = item(); void persist(selected.group, refs => refs.some(ref => starterKey(ref) === starterKey(selected.ref)) ? refs : [...refs, selected.ref], active); }}><Text class="text-sm text-foreground">{item().label}</Text></Button>}</Each></View></If>}</Each><If when={!catalogBusy() && !error() && !options().length}><Text class="text-sm text-muted-foreground">{t('chat.draftStarters.empty')}</Text></If></Scroll>
    </View>}</NativeNewSessionModal>
  </>;
}

function NewSessionProjects(props: { owner: Pick<Ownership['owner'], 'directory'>; projects: () => Project[]; current: () => boolean; onChoose: (project: Project | undefined, directory: string) => Promise<void> }) {
  const directory = signal(props.owner.directory), pending = signal(false);
  async function choose(project: Project | undefined, path: string) { if (!props.current() || pending() || !path.trim()) return; pending.set(true); try { await props.onChoose(project, path.trim()); } finally { pending.set(false); } }
  return <Scroll class="flex-1" contentClass="p-4 pb-8 gap-3"><Text class="text-base text-foreground font-semibold">{t('sessions.scheduledTasks.dialog.project.label')}</Text><Each of={props.projects()}>{project => <Button testID={`new-session-project-${project().id}`} class={action + ' items-start'} disabled={pending()} selected={props.owner.directory === project().path} onPress={() => { void choose(project(), project().path); }}><Text class="text-foreground">{project().name}</Text><Text class="text-xs text-muted-foreground">{project().path}</Text></Button>}</Each><Input testID="new-session-directory" class="min-h-11 rounded-xl bg-card px-3 text-foreground" value={directory()} onChange={event => directory.set(event.value)} placeholder={t('directoryExplorerDialog.pathInput.placeholder')} accessibilityLabel={t('directoryExplorerDialog.pathInput.placeholder')} autoCapitalize="none" autoCorrect={false} /><NativeNewSessionInputAX field="directory" label={t('directoryExplorerDialog.pathInput.placeholder')} /><Button testID="new-session-directory-choose" class={action} disabled={pending() || !directory().trim()} onPress={() => { const path = directory().trim(), project = [...props.projects()].sort((a, b) => b.path.length - a.path.length).find(item => path === item.path || path.startsWith(`${item.path.replace(/\/$/, '')}/`)); void choose(project ?? { id: '', name: nameOf(path), path }, path); }}><Text class="text-foreground">{t('directoryExplorerDialog.footer.select')}</Text></Button></Scroll>;
}

function NewSessionRecovery(props: { owner: Ownership['owner']; current: () => boolean; pending: () => boolean; perform: (work: () => Promise<unknown>) => Promise<void> }) {
  const sessionID = signal(''), candidates = signal<Session[]>([]), loading = signal(false);
  async function load() {
    await props.perform(async () => {
      const captured = props.owner.captureOperation();
      loading.set(true);
      try { const sessions = sessionsFrom(await captured.request('/api/yuri/session-index')); if (props.current() && captured.current()) candidates.set(sessions.filter(session => session.directory === props.owner.directory).slice(0, 20)); }
      finally { loading.set(false); }
    });
  }
  return <View testID="new-session-create-unknown" class="rounded-2xl bg-card p-4 gap-3"><Text role="alert" class="text-base font-semibold text-foreground">{newSessionText('unknownTitle')}</Text><Text class="text-sm text-muted-foreground">{newSessionText('unknownBody')}</Text><Text testID="new-session-stable-id" class="text-xs text-muted-foreground">{props.owner.inputID()}</Text><Button testID="new-session-recovery-refresh" class={action} disabled={!props.current() || props.pending() || loading()} onPress={() => { void load(); }}><Text class="text-foreground">{newSessionText('reviewSessions')}</Text></Button><Each of={candidates()}>{session => <Button testID={`new-session-recovery-candidate-${session().id}`} class={action + ' items-start'} disabled={props.pending()} selected={sessionID() === session().id} onPress={() => sessionID.set(session().id)}><Text class="text-foreground">{session().title}</Text><Text class="text-xs text-muted-foreground">{session().id}</Text></Button>}</Each><Input testID="new-session-recovery-id" class="min-h-11 rounded-xl bg-secondary px-3 text-foreground" value={sessionID()} onChange={event => sessionID.set(event.value)} autoCapitalize="none" autoCorrect={false} placeholder={newSessionText('recoveryID')} accessibilityLabel={newSessionText('recoveryID')} /><Button testID="new-session-recovery-use" class={action} disabled={!props.current() || props.pending() || !sessionID().trim()} onPress={() => { void props.perform(() => props.owner.recoverCreatedSession(sessionID())); }}><Text class="text-foreground">{newSessionText('recoveryChoose')}</Text></Button></View>;
}
