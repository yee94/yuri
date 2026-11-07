import { cleanup, computed, effect, Keyboard, keyboardFrame, lifecycle, Overlay, safeArea, signal, Speech, Scroll, Text, token, untracked, View, windowSize, type SpeechSession, type ViewRef } from 'nsh';
import { AlertDialog, Button, Input, NavPage } from 'nsh/base';
import { nativeChatTextStyle } from './appearance';
import { NativeAgentAvatar, NativeModelLogo, nativeAgentAccent } from './chat-identity';
import { pickerPreferences, pickerSheetHeight } from './chat-models-helpers';
import { NativeCommandSuggestions } from './composer-controls';
import { nativeComposerSurface } from './composer-surface';
import { shouldSubmitCommandOnSelection } from './composer-commands-model';
import { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';
import { NativeReferencePicker } from './composer-references-controls';
import { NativeComposerSend } from './composer-send';
import { Icon } from './Icon';
import { t } from './i18n';
import { nameOf, record, rowsFrom, sessionsFrom, text, type Attachment, type ChatTarget, type Project, type Row, type Session } from './model';
import { createNativeNewSessionOwnership, type NativeNewSessionPageHandoff } from './new-session';
import { newSessionText } from './new-session-copy';
import { NativeNewSessionModels } from './new-session-models';
import { NativeNewSessionModal } from './new-session-modal';
import { NativeNewSessionInputAX } from './new-session-native-owners';
import { native } from './runtime';
import { app, captureHostRequest } from './state';
import { getAgentDisplayName, getCycledPrimaryAgentName } from '../ui/src/components/chat/mobileControlsUtils';
import { LONG_PRESS_MS, LONG_PRESS_MOVE_PX } from '../ui/src/lib/touch-gestures/tap';
import { createNewSessionCatalog } from './new-session-selection';
import { agentDraftSelection, closestStarter, createAgentPress, getBuiltInStarter, globalStarterRefs, moveStarter, projectStarterConfig, projectStarterLocation, resolveStarters, sanitizeStarterRefs, STARTER_TRASH, starterKey, starterOptions, starterShifts, type DraftStarterRef, type StarterGroup, type StarterItem, type StarterRect } from './new-session-ui-helpers';

type Ownership = ReturnType<typeof createNativeNewSessionOwnership>;
const action = 'min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';

export interface NativeNewSessionPageProps {
  project?: Project;
  directory?: string;
  active: boolean;
  projects?: Project[];
  /** Current active owner only; undefined clears the model but retains directory. */
  onSelection?: (directory: string, selection?: { providerID: string; modelID: string; variant?: string }, agent?: string) => void;
  onOpenChat: (target: ChatTarget, handoff: NativeNewSessionPageHandoff) => void;
  /** Notification only: native NavStack has already popped. Do not pop again. */
  onBack?: () => void;
}

export function NativeNewSessionPage(props: NativeNewSessionPageProps) {
  let alive = true;
  const current = () => alive && props.active && lifecycle() === 'active';
  const ownership = signal<Ownership | null>(null), switching = signal(false), error = signal(''), starterGesture = signal(false);
  function open(project?: Project, directory?: string) {
    try { ownership.set(createNativeNewSessionOwnership({ project, directory, active: current })); }
    catch { error.set(t('common.unavailable')); }
  }
  open(props.project, props.directory);
  async function changeProject(project: Project | undefined, directory: string) {
    const previous = ownership();
    if (!current() || switching() || !previous || previous.owner.phase() !== 'draft' || previous.owner.submitting()) return;
    const operation = previous.owner.operation()!;
    switching.set(true); error.set('');
    try {
      // Flush before retiring the current partition. Failed persistence keeps the
      // existing page/input instead of silently opening an empty new partition.
      await previous.owner.durable.flush();
      if (!current() || !operation.current()) return;
      await previous.disposePage();
      if (!alive || !operation.current()) return;
      open(project, directory);
    } catch { if (alive) error.set(newSessionText('storageFailed')); }
    finally { if (alive) switching.set(false); }
  }
  effect(() => {
    const entry = ownership();
    if (!current() || !entry?.transferred() || !entry.released()) return;
    open(entry.owner.project.id ? entry.owner.project : undefined, entry.owner.directory);
  });
  cleanup(() => { alive = false; void ownership()?.disposePage().catch(() => {}); });
  return <NavPage testID="new-session-page" title={t('mobile.menu.newSession')} headerBackTitle="" class="flex-1 bg-background" popOnSwipe={!current() || !starterGesture()} onDismiss={() => { starterGesture.set(false); void ownership()?.disposePage().catch(() => {}); props.onBack?.(); }}>
    <If when={!!error()}><View class="p-4 gap-2"><Text role="alert" class="text-sm text-destructive">{error()}</Text><If when={!ownership()}><Button class={action} onPress={() => { error.set(''); open(props.project, props.directory); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If></View></If>
    <Each of={ownership() ? [ownership()!] : []}>{entry => <NewSessionBody ownership={entry()} active={current} projects={() => props.projects ?? app.projects()} switching={switching} onChangeProject={changeProject} onOpenChat={props.onOpenChat} onSelection={props.onSelection} onStarterGestureChange={active => starterGesture.set(active)} />}</Each>
  </NavPage>;
}

function NewSessionBody(props: { ownership: Ownership; active: () => boolean; projects: () => Project[]; switching: () => boolean; onChangeProject: (project: Project | undefined, directory: string) => Promise<void>; onOpenChat: NativeNewSessionPageProps['onOpenChat']; onSelection?: NativeNewSessionPageProps['onSelection']; onStarterGestureChange?: (active: boolean) => void }) {
  const request = captureHostRequest();
  const ownership = props.ownership, owner = ownership.owner;
  const panel = signal<'model' | 'agent' | 'project' | null>(null), mode = signal<'normal' | 'shell'>('normal');
  const error = signal(''), pending = signal(false), attaching = signal(false), recording = signal(false), commands = signal<Row[]>([]);
  const anchor = signal<ViewRef | null>(null);
  let alive = true, speech: SpeechSession | undefined, speechOperation = 0;
  let pendingProject: { project: Project | undefined; directory: string } | undefined;
  const current = () => alive && props.active() && owner.current() && !props.switching();
  const selectionEnabled = () => current() && owner.phase() === 'draft' && !owner.submitting();
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
  const keyboard = createNativeReferenceKeyboard({ active: () => current() && !panel() && mode() === 'normal' && !recording(), scope: () => owner.durable.scope, text: owner.durable.draft, insert: owner.insertReference,
    chooseCommand: (command, submitIntent, context) => {
      if (!current()) return false;
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
  cleanup(() => { alive = false; stopSpeech(); });
  async function perform(work: () => Promise<unknown>) {
    if (!current() || pending()) return;
    pending.set(true); error.set('');
    try { await work(); }
    catch (failure) {
      if (alive && props.active()) error.set(failure instanceof Error && failure.message === 'new-session-recovery-not-empty' ? newSessionText('recoveryNotEmpty') : failure instanceof Error && failure.message === 'new-session-recovery-directory-mismatch' ? newSessionText('recoveryMismatch') : newSessionText('operationFailed'));
    } finally { if (alive) pending.set(false); }
  }
  async function submit() {
    if (!current() || owner.submitting() || ownership.transferred()) return;
    if (mode() === 'normal' && /^\/model(?:\s|$)/i.test(owner.durable.draft().trim())) {
      owner.setDraftText(owner.durable.draft().trimStart().replace(/^\/model\s*/i, ''));
      Keyboard.dismiss(); panel.set('model'); return;
    }
    await perform(async () => {
      const receipt = await owner.submit({ inputMode: mode() });
      if (!receipt || !current()) return;
      Keyboard.dismiss(); panel.set(null); stopSpeech();
      const handoff = ownership.transfer(receipt);
      try { props.onOpenChat(receipt.target, handoff); }
      catch (failure) { ownership.reclaim(handoff); throw failure; }
    });
  }
  async function attach() {
    if (!current() || attaching() || mode() === 'shell') return;
    const captured = owner.captureOperation();
    attaching.set(true);
    try {
      const choice = await AlertDialog.show({ title: t('chat.chatInput.actions.addAttachment'), presentation: 'actionSheet', actions: [{ id: 'images', label: t('chat.chatInput.actions.attachPhotos') }, { id: 'files', label: t('chat.chatInput.actions.attachFiles') }, { id: 'cancel', label: t('chat.chatInput.actions.attachCancel'), role: 'cancel' }] });
      if (!current() || !captured.current() || choice.action !== 'files' && choice.action !== 'images') return;
      const attachment = await native<Attachment | null>('runtime.pickAttachment', { kind: choice.action });
      if (current() && captured.current() && attachment) owner.setAttachments([...owner.durable.attachments(), attachment]);
    } catch { if (current()) error.set(newSessionText('operationFailed')); }
    finally { if (alive) attaching.set(false); }
  }
  async function dictate() {
    if (recording()) { speech?.stop(); return; }
    if (!current()) return;
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
  const welcomeTitle = () => owner.project.name ? t('chat.emptyState.draftTitleWithProject', { project: owner.project.name }) : t('chat.emptyState.draftTitle');
  const projectTitleIndex = () => owner.project.name ? welcomeTitle().indexOf(owner.project.name) : -1;
  return <View class="flex-1">
    <If when={ownership.transferred()} else={<>
      <Scroll class="flex-1" contentClass="grow justify-center px-6 py-4 gap-4">
        <View class="items-center">
          <Text class="text-foreground" style={{ fontSize: 30, lineHeight: 36, fontWeight: '400', letterSpacing: -0.75, textAlign: 'center', maxWidth: 448 }}><If when={projectTitleIndex() >= 0} else={welcomeTitle()}>{welcomeTitle().slice(0, projectTitleIndex())}<Text style={{ fontWeight: '500' }}>{owner.project.name}</Text>{welcomeTitle().slice(projectTitleIndex() + owner.project.name.length)}</If></Text>
          <NativeNewSessionStarters owner={owner} active={() => selectionEnabled() && !panel()} visible={() => owner.phase() === 'draft' && keyboardFrame().height === 0} onGestureActiveChange={props.onStarterGestureChange} onSubmit={item => {
            if (!selectionEnabled() || pending() || recording() || attaching()) return;
            const draft = owner.durable.draft();
            mode.set('normal');
            if (item.ref.type === 'skill') owner.insertReference({ kind: 'skill', value: item.ref.name, label: item.ref.name, scope: owner.durable.scope }, 0, 0);
            else owner.setDraftText(`${item.submitText}${draft.trim() ? `\n${draft}` : ''}`);
            void submit();
          }} />
        </View>
        <If when={owner.creationUnknown() && !owner.submitting()}><NewSessionRecovery owner={owner} current={current} pending={pending} perform={perform} /></If>
        <If when={owner.phase() !== 'draft' && !owner.submitting() && !!owner.durable.pendingSend()}><View testID="new-session-captured-input" class="rounded-xl bg-card p-3 gap-2"><Text class="text-xs text-muted-foreground">{newSessionText('capturedInput')}</Text><Text class="text-sm text-foreground">{owner.durable.pendingSend()?.text}</Text><Each of={owner.durable.pendingSend()?.files ?? []}>{file => <Text class="text-xs text-muted-foreground">{file().name}</Text>}</Each></View></If>
        <If when={!!owner.target()}><Text testID="new-session-existing-target" class="text-sm text-muted-foreground">{newSessionText('selectedSession', { id: owner.target()?.id ?? '' })}</Text></If>
        <If when={owner.status() === 'loading' || owner.durable.status() === 'loading'}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If>
        <If when={owner.status() === 'error' || owner.durable.status() === 'error' || !!error()}><View testID="new-session-error" class="gap-2"><Text role="alert" class="text-sm text-destructive">{error() || (owner.durable.status() === 'error' || owner.error() === 'new-session-restore-failed' ? newSessionText('storageFailed') : owner.creationUnknown() ? newSessionText('unknownTitle') : newSessionText('operationFailed'))}</Text><Button testID="new-session-storage-retry" class={action} disabled={!current() || pending() || owner.submitting()} onPress={() => { void perform(owner.retryStorage); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></View></If>
      </Scroll>
      <View class="px-3 pt-2" style={{ paddingBottom: keyboardFrame().height > 0 ? keyboardFrame().height : safeArea().bottom + 16, transitionProperty: 'all', transitionDuration: keyboardFrame().duration }}>
        <View class="mb-1.5 px-0.5 flex-row items-center gap-1.5"><Button testID="new-session-project" class="h-[26px] px-1.5 flex-row items-center gap-1.5 rounded-lg active:bg-accent disabled:opacity-40" style={{ maxWidth: '46%' }} hitSlop={8} disabled={!selectionEnabled()} accessibilityLabel={`${owner.project.name || t('sessions.scheduledTasks.dialog.error.chooseProjectFirst')}${owner.directory ? ` ${owner.directory}` : ''}`} onPress={() => { Keyboard.dismiss(); panel.set('project'); }}><View style={{ opacity: 0.8 }}><Icon name="folder" size={14} /></View><Text class="text-foreground" style={{ fontSize: 11, lineHeight: 14, fontWeight: '500', opacity: 0.8, flexShrink: 1, numberOfLines: 1 }}>{owner.project.name || t('sessions.scheduledTasks.dialog.error.chooseProjectFirst')}</Text></Button></View>
        <View testID="new-session-composer-glass" ref={node => anchor.set(node)} class="px-3 pt-1 pb-1" style={nativeComposerSurface}>
          <Each of={owner.durable.attachments()}>{attachment => <View class="flex-row items-center gap-2"><Text class="flex-1 text-sm text-foreground">{attachment().name}</Text><Button testID={`new-session-remove-attachment-${attachment().name}`} class="min-h-10 min-w-10 items-center justify-center" disabled={!current() || owner.submitting()} accessibilityLabel={t('chat.chatInput.actions.attachCancel')} onPress={() => owner.setAttachments(owner.durable.attachments().filter(file => file !== attachment()))}><Icon name="close" size={16} /></Button></View>}</Each>
          <Input testID="new-session-composer" ref={keyboard.ref} class="min-h-[52px] max-h-36 py-[10px] text-foreground" style={{ ...nativeChatTextStyle('composer'), backgroundColor: 'transparent', borderWidth: 0 }} multiline readonly={recording() || !current()} value={owner.durable.draft()} selectedRange={keyboard.selectedRange()} onFocus={keyboard.onFocus} onBlur={keyboard.onBlur} submitBehavior={keyboard.submitBehavior()} onSubmit={keyboard.onSubmit} onSelectionChange={keyboard.onSelectionChange} onCompositionChange={keyboard.onCompositionChange} onChange={event => { keyboard.beforeChange(); if (!owner.durable.draft() && mode() === 'normal' && event.value.startsWith('!')) { mode.set('shell'); owner.setDraftText(event.value.slice(1)); } else owner.setDraftText(event.value); keyboard.refresh(); }} placeholder={t(mode() === 'shell' ? 'chat.chatInput.placeholder.shell' : 'chat.chatInput.placeholder.chatCompact')} />
          <View class="min-h-10 flex-row items-center gap-1.5">
            <Button testID="new-session-attach" class="size-8 rounded-full items-center justify-center active:bg-accent disabled:opacity-40" hitSlop={6} disabled={!current() || attaching() || mode() === 'shell'} accessibilityLabel={t('chat.chatInput.actions.addAttachment')} onPress={() => { void attach(); }}><View style={{ opacity: 0.8 }}><Icon name="attachment-2" size={18} /></View></Button>
            <Button testID="new-session-dictate" class="size-8 rounded-full items-center justify-center active:bg-accent disabled:opacity-40" hitSlop={6} disabled={!current() || owner.submitting()} accessibilityLabel={t('chat.dictation.start')} onPress={() => { void dictate(); }}><View style={{ opacity: recording() ? 1 : 0.8 }}><Icon name={recording() ? 'stop' : 'mic'} size={18} /></View></Button>
            <If when={mode() === 'shell'}><Button testID="new-session-normal-mode" class="min-h-10 px-1" accessibilityLabel={t('settings.common.actions.cancel')} onPress={() => mode.set('normal')}><Text class="text-xs text-foreground">! ×</Text></Button></If>
            <View class="flex-1" />
            <NativeNewSessionAgent owner={owner} active={selectionEnabled} onOpen={() => { Keyboard.dismiss(); panel.set('agent'); }} onError={() => error.set(newSessionText('operationFailed'))} />
            <Button testID="new-session-model" class="max-w-36 flex-row items-center gap-1 rounded-lg active:bg-accent disabled:opacity-40" style={{ height: 26 }} hitSlop={6} disabled={!selectionEnabled()} accessibilityLabel={`${owner.selection().model?.id || t('chat.modelControls.selectModel')}${owner.selection().model?.variant ? ` ${owner.selection().model?.variant}` : ''}`} onPress={() => { Keyboard.dismiss(); panel.set('model'); }}><If when={!!owner.selection().model}><NativeModelLogo modelID={owner.selection().model?.id} providerID={owner.selection().model?.providerID} size={16} /></If><Text class="text-foreground" style={{ fontSize: 11, lineHeight: 14, fontWeight: '500', opacity: 0.8, maxWidth: 96, flexShrink: 1, numberOfLines: 1 }}>{owner.selection().model?.id || t('chat.modelControls.selectModel')}</Text><If when={!!owner.selection().model?.variant}><Text class="text-muted-foreground" style={{ fontSize: 11, lineHeight: 14, flexShrink: 1, numberOfLines: 1 }}>{owner.selection().model?.variant}</Text></If></Button>
            <NativeComposerSend hasContent={hasContent()} inFlight={owner.submitting()} disabled={!current() || owner.status() === 'loading' || owner.durable.status() !== 'ready' || pending() || attaching() || recording() || !owner.directory || !hasContent() && owner.phase() === 'draft' || owner.creationUnknown()} onPress={() => { void submit(); }} />
          </View>
        </View>
        <If when={!!keyboard.commandTrigger() && !!anchor() && !panel()}><Overlay testID="new-session-command-panel" anchor={anchor()} placement="top" align="start" offset={8} margin={12} style={{ width: windowSize().width - 24 }} onPressOutside={keyboard.dismiss} onCancel={keyboard.dismiss}><NativeCommandSuggestions scope={owner.durable.scope} keyboard={keyboard} commands={commands()} loadCommands={loadCommands} /></Overlay></If>
        <If when={!!keyboard.trigger() && !!anchor() && !panel()}><Overlay testID="new-session-reference-panel" anchor={anchor()} placement="top" align="start" offset={8} margin={12} style={{ width: windowSize().width - 24 }} onPressOutside={keyboard.dismiss} onCancel={keyboard.dismiss}><NativeReferencePicker scope={owner.durable.scope} keyboard={keyboard} open query={keyboard.trigger()?.query} request={request} onClose={keyboard.dismiss} /></Overlay></If>
      </View>
    </>}><View testID="new-session-transferred" class="p-5 gap-3"><Text class="text-sm text-muted-foreground">{newSessionText('handedOff')}</Text></View></If>
    <NativeNewSessionModal value={panel()} active={selectionEnabled} onClose={() => panel.set(null)} onDismiss={value => {
      if (value !== 'project') return;
      const choice = pendingProject; pendingProject = undefined;
      if (choice && selectionEnabled() && !panel()) void props.onChangeProject(choice.project, choice.directory);
    }} height={pickerSheetHeight(windowSize().height, safeArea())}>{(value, active, close, sheet) => <>
      <If when={value === 'model' || value === 'agent'}><View class="flex-1" style={{ paddingBottom: safeArea().bottom }}><NativeNewSessionModels owner={owner} mode={value === 'agent' ? 'agent' : 'model'} active={active} onDone={close} sheet={sheet} /></View></If>
      <If when={value === 'project'}><NewSessionProjects owner={owner} projects={props.projects} current={active} onChoose={async (project, directory) => { if (active()) { pendingProject = { project, directory }; close(); } }} /></If>
    </>}</NativeNewSessionModal>
  </View>;
}

function NativeNewSessionAgent(props: { owner: Ownership['owner']; active: () => boolean; onOpen: () => void; onError: () => void }) {
  const request = captureHostRequest();
  let alive = true, wasActive = false, labelTimer: ReturnType<typeof setTimeout> | undefined, origin: { x: number; y: number } | undefined;
  const current = () => alive && props.active() && props.owner.current();
  const catalog = createNewSessionCatalog(props.owner.directory, () => alive && props.owner.current(), request), pending = signal(false), labelVisible = signal(false);
  const primaryAgents = computed(() => catalog.agents().map(agent => ({ name: text(agent.name), mode: agent.mode === 'primary' ? 'primary' as const : agent.mode === 'all' ? 'all' as const : undefined })));
  async function load() { await catalog.load('agent'); if (current() && !catalog.error()) await catalog.load('model'); }
  async function cycle() {
    if (!current() || pending()) return;
    pending.set(true);
    try {
      if (!catalog.resolved() || catalog.error()) await load();
      if (!current()) return;
      if (catalog.error()) throw new Error('catalog-unavailable');
      const previous = props.owner.selection().agent, next = getCycledPrimaryAgentName(primaryAgents(), previous);
      if (!next) return;
      await props.owner.select(agentDraftSelection(props.owner.selection(), next, catalog.agents(), catalog.providers()));
      if (!current() || !previous || previous === next) return;
      if (labelTimer) clearTimeout(labelTimer);
      labelVisible.set(true); labelTimer = setTimeout(() => { labelTimer = undefined; if (alive) labelVisible.set(false); }, 1000);
    } catch { if (current()) props.onError(); }
    finally { if (alive) pending.set(false); }
  }
  const press = createAgentPress({ enabled: () => current() && !pending(), cycle: () => { void cycle(); }, open: props.onOpen, schedule: work => setTimeout(work, LONG_PRESS_MS), cancelTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) });
  effect(() => { if (!props.active()) { wasActive = false; press.cancel(); labelVisible.set(false); if (labelTimer) clearTimeout(labelTimer); labelTimer = undefined; } else if (!wasActive) { wasActive = true; void load(); } });
  cleanup(() => { alive = false; press.cancel(); catalog.dispose(); if (labelTimer) clearTimeout(labelTimer); });
  return <View class="flex-row items-center" onTouchStartCapture={event => { origin = { x: event.pageX, y: event.pageY }; }} onTouchMoveCapture={event => { if (event.touches.length > 1 || origin && Math.hypot(event.pageX - origin.x, event.pageY - origin.y) > LONG_PRESS_MOVE_PX) press.cancel(); }} onTouchCancel={press.cancel} onMouseLeave={press.cancel}>
    <Button testID="new-session-agent" class="rounded-lg flex-row items-center active:bg-accent disabled:opacity-40" style={{ height: 26 }} hitSlop={6} disabled={!props.active() || pending()} accessibilityLabel={props.owner.selection().agent ? getAgentDisplayName(primaryAgents(), props.owner.selection().agent) : t('chat.modelControls.selectAgent')} onPressDown={press.down} onPressUp={press.up} onPress={press.press}>
      <View class="items-center justify-center" style={{ width: 24, height: 26 }}><If when={!!props.owner.selection().agent} else={<Icon name="user" size={16} />}><NativeAgentAvatar name={props.owner.selection().agent} size={16} /></If></View>
      <View accessibilityElementsHidden={!labelVisible()} style={{ maxWidth: labelVisible() ? 160 : 0, opacity: labelVisible() ? 1 : 0, overflow: 'hidden', transitionProperty: 'all', transitionDuration: 280, transitionTimingFunction: 'ease-in-out' }}><Text class="pl-1 pr-0.5 text-xs" style={{ color: nativeAgentAccent(props.owner.selection().agent), numberOfLines: 1 }}>{props.owner.selection().agent ? getAgentDisplayName(primaryAgents(), props.owner.selection().agent) : t('chat.modelControls.selectAgent')}</Text></View>
    </Button>
  </View>;
}

function NativeNewSessionStarters(props: { owner: Ownership['owner']; active: () => boolean; visible: () => boolean; onSubmit: (item: StarterItem) => void; onGestureActiveChange?: (active: boolean) => void }) {
  const request = captureHostRequest();
  const global = signal<DraftStarterRef[]>([]), project = signal<DraftStarterRef[]>([]), commands = signal<Row[]>([]), skills = signal<Row[]>([]);
  const globalReady = signal(false), projectReady = signal(false), loading = signal(false), catalogBusy = signal(false), saving = signal(false), error = signal('');
  const open = signal(false), search = signal(''), expanded = signal(false), overflow = signal(false);
  const drag = signal<{ id: string; dx: number; dy: number; over: string | null; rects: StarterRect[]; hidden: Set<string>; shifts: Map<string, { x: number; y: number }> } | null>(null);
  const refs = new Map<string, ViewRef>();
  let alive = true, wasActive = false, timer: ReturnType<typeof setTimeout> | undefined, gesture = 0, suppressed = false, origin: { x: number; y: number } | undefined;
  let layout: { width: number; height: number } | undefined;
  const current = () => alive && props.active() && props.owner.current();
  const chipsActive = () => current() && props.visible() && !open();
  const hasProject = !!props.owner.project.id && !!props.owner.project.path;
  const items = computed(() => [...resolveStarters(global(), 'global', commands(), skills(), t), ...resolveStarters(project(), 'project', commands(), skills(), t)]);
  const options = computed(() => starterOptions(global(), project(), commands(), skills(), t).filter(item => (item.group !== 'project' || hasProject) && `${item.label} ${item.ref.name}`.toLocaleLowerCase().includes(search().trim().toLocaleLowerCase())));
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
  function cancelDrag() { const held = !!origin; gesture++; if (timer) clearTimeout(timer); timer = undefined; origin = undefined; drag.set(null); if (held) props.onGestureActiveChange?.(false); }
  async function beginDrag(item: StarterItem, ticket: number) {
    const measured = await Promise.all([...items().map(item => item.id), STARTER_TRASH].map(async id => { const size = await refs.get(id)?.measure(); return size ? { id, x: size.pagePosition.x, y: size.pagePosition.y, width: size.bounds.size.width, height: size.bounds.size.height } : null; }));
    if (!chipsActive() || ticket !== gesture || !origin) { if (ticket === gesture) cancelDrag(); return; }
    const rects = measured.filter((rect): rect is StarterRect => !!rect), own = rects.find(rect => rect.id === item.id);
    if (!own) { cancelDrag(); return; }
    const firstRow = Math.min(...rects.filter(rect => rect.id !== STARTER_TRASH).map(rect => rect.y));
    const hidden = new Set(!expanded() ? rects.filter(rect => rect.id !== STARTER_TRASH && rect.y >= firstRow + 28).map(rect => rect.id) : []);
    if (hidden.has(item.id)) { cancelDrag(); return; }
    suppressed = true; drag.set({ id: item.id, dx: 0, dy: 0, over: item.id, rects: rects.filter(rect => !hidden.has(rect.id)), hidden, shifts: new Map() });
  }
  function startDrag(item: StarterItem, x: number, y: number) {
    cancelDrag(); suppressed = true;
    if (!chipsActive() || saving()) return;
    suppressed = false;
    origin = { x, y }; props.onGestureActiveChange?.(true); const ticket = gesture;
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
  function finishDrag() {
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
  const translation = (id: string) => { const active = drag(); return !active ? { x: 0, y: 0 } : active.id === id ? { x: active.dx, y: active.dy } : active.shifts.get(id) ?? { x: 0, y: 0 }; };
  effect(() => {
    const active = props.active(), enabled = chipsActive();
    untracked(() => { if (!active) { wasActive = false; open.set(false); } else if (!wasActive) { wasActive = true; void load(); } if (!enabled) { suppressed = true; cancelDrag(); } });
  });
  cleanup(() => { alive = false; suppressed = true; cancelDrag(); refs.clear(); });
  return <>
    <If when={props.visible()}><View class="mt-8 w-full gap-2" style={{ maxWidth: 448 }}>
      <View class="flex-row items-start gap-0.5">
        <View class="flex-1" style={{ maxHeight: expanded() ? undefined : 28, overflow: expanded() || !!drag() ? 'visible' : 'hidden' }}><View class="flex-row flex-wrap items-center justify-center gap-0.5" onLayout={event => layoutChips(event.bounds.size)}><Each of={items()}>{item => <View ref={ref => refs.set(item().id, ref)} style={{ zIndex: drag()?.id === item().id ? 10 : 0, opacity: drag()?.hidden.has(item().id) ? 0 : drag()?.id === item().id ? 0.6 : 1, pointerEvents: drag()?.hidden.has(item().id) ? 'none' : 'auto', transform: [{ translateX: translation(item().id).x }, { translateY: translation(item().id).y }], transitionProperty: 'transform', transitionDuration: drag()?.id === item().id ? 0 : 200, transitionTimingFunction: 'ease' }} onTouchStartCapture={event => { if (event.touches.length > 1) { suppressed = true; cancelDrag(); } else startDrag(item(), event.pageX, event.pageY); }} onTouchMoveCapture={event => moveDrag(event.pageX, event.pageY, event.touches.length)} onTouchEndCapture={finishDrag} onTouchCancel={() => { suppressed = true; cancelDrag(); }} onMoveShouldSetResponderCapture={() => !!drag()} onResponderGrant={() => true} onResponderMove={event => moveDrag(event.pageX, event.pageY, event.touches.length)} onResponderRelease={finishDrag} onResponderTerminate={() => { suppressed = true; cancelDrag(); }} onResponderTerminationRequest={() => !drag()}>
          <Button testID={`new-session-preset-${item().submitText.startsWith('/') ? item().submitText.slice(1) : `skill-${item().ref.name}`}`} class="h-7 px-2 flex-row items-center gap-1 rounded-md active:bg-accent disabled:opacity-40" disabled={!chipsActive() || saving()} onPressDown={() => { if (origin && !drag() && chipsActive()) suppressed = false; }} onPress={() => { if (!suppressed && chipsActive() && !saving()) { suppressed = true; props.onSubmit(item()); } }}><View style={{ opacity: 0.6 }}><Icon name={item().icon} size={12} color={token('muted-foreground')} /></View><Text class="text-xs text-muted-foreground">{item().label}</Text></Button>
        </View>}</Each></View></View>
        <If when={overflow() || expanded()}><Button testID="new-session-presets-expand" class="size-6 rounded-md items-center justify-center active:bg-accent" hitSlop={6} accessibilityLabel={t(expanded() ? 'chat.draftStarters.collapse' : 'chat.draftStarters.expand')} onPress={() => { if (!chipsActive() || saving()) return; suppressed = true; cancelDrag(); expanded.set(!expanded()); }}><Icon name={expanded() ? 'arrow-up-s' : 'arrow-down-s'} size={14} /></Button></If>
        <View ref={ref => refs.set(STARTER_TRASH, ref)}><If when={!!drag()} else={<Button testID="new-session-presets-add" class="size-6 rounded-md items-center justify-center active:bg-accent disabled:opacity-40" hitSlop={6} disabled={!props.active() || loading() || saving() || !globalReady() || !projectReady()} accessibilityLabel={t('chat.draftStarters.add')} onPress={() => { if (!chipsActive() || loading() || saving() || !globalReady() || !projectReady()) return; suppressed = true; cancelDrag(); Keyboard.dismiss(); search.set(''); open.set(true); error.set(''); void loadCatalog(); }}><Icon name="add" size={14} color={token('muted-foreground')} /></Button>}><View testID="new-session-presets-trash" accessibilityLabel={t('chat.draftStarters.remove')} class="size-6 items-center justify-center rounded-md"><Icon name="delete-bin" size={14} color={token(drag()?.over === STARTER_TRASH ? 'destructive' : 'muted-foreground')} /></View></If></View>
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

function NewSessionProjects(props: { owner: Ownership['owner']; projects: () => Project[]; current: () => boolean; onChoose: (project: Project | undefined, directory: string) => Promise<void> }) {
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
