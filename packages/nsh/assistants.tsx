import { cleanup, computed, effect, host, lifecycle, List, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button, Input } from 'nsh/base';
import { t } from './i18n';
import { Icon } from './Icon';
import { record, runtimeEventFrom, text, type ChatTarget, type Row } from './model';
import { adoptAssistantCatalogSnapshot, app, epoch } from './state';
import { desktopSidebarScope } from './desktop-sidebar-model';
import { createPageOperations } from './page-operations';
import { assistantContacts, assistantPreview, assistantRequest, markAssistantCatalogRead, mutateAssistant, readAssistantSnapshot, snapshotBots, type AssistantFence } from './assistants-core';
import { AssistantSwipeRow } from './assistants-swipe';
import { AssistantAvatar } from './assistants-avatar-live';
import { DesktopAssistantWorkspace, type DesktopAssistantPresentation } from './desktop-assistants';
import { resolveAssistantWorkspacePresentation } from '../ui/src/components/assistants/assistantWorkspaceState';

export { AssistantDetails } from './assistants-details';
export { AssistantSettings } from './assistants-settings';
export { AssistantAvatar } from './assistants-avatar-live';
export const assistantChatTarget = (bot: Row): ChatTarget => ({ kind: 'assistant', id: text(bot.id), title: text(bot.name), directory: text(bot.effectiveWorkspacePath) });
const small = 'h-10 w-10 rounded-full bg-secondary items-center justify-center active:bg-accent disabled:opacity-40';
export type AssistantHomeProps = DesktopAssistantPresentation & {
  onOpenChat: (target: ChatTarget) => void;
  onCreate: () => void;
  onEdit: (bot: Row) => void;
  onOpenSettings?: () => void;
  active?: boolean;
  presentation?: 'mobile' | 'desktop';
  /** Temporary desktop Dialog admission, independent of the retained catalog owner. */
  interactive?: boolean;
  /** Root releases the exact inline writer before invoking commit; false/unknown never commits. */
  requestConversationChange?: (commit: () => void, current: () => boolean) => Promise<boolean>;
  /** Exact root navigation request, consumed only by this fresh catalog owner. */
  initialAssistantID?: string;
  /** Reuse the same guarded selection handler for desktop resource references. */
  onConversationNavigation?: (select: (assistantID: string, current: () => boolean) => Promise<boolean>) => void | (() => void);
};
export function AssistantHome(props: AssistantHomeProps) {
  const operations = createPageOperations(() => props.active !== false && app.tab() === 1);
  let alive = true, sequence = 0, revision = -1;
  cleanup(() => { alive = false; sequence++; });
  const fence = { current: () => alive && operations.current() };
  const capture = (): AssistantFence => { const lane = operations.capture(); return { current: () => alive && lane.current(), request: lane.request }; };
  const loading = signal(false), busy = signal(false), error = signal(''), search = signal(''), searching = signal(false), capability = signal<Row | null>(null), enabled = signal<boolean | null>(null);
  const revealed = signal<string | null>(null);
  /** Only the mounted slot's rendering snapshot; never catalog or mutation authority. */
  type Conversation = { serial: number; bot: Row; retired: boolean };
  const selected = signal<Conversation | null>(null);
  const desktopAssistant = computed(() => selected()?.bot ?? null);
  const conversationFlight = signal(false);
  let conversationIntent = 0, conversationSerial = 0, retirementAttempted = 0, initiallySelected = false;
  let pendingConversationCurrent: (() => boolean) | null = null;
  let interactionRevision = 0;
  effect(() => { if (props.presentation === 'desktop' && props.interactive === false) interactionRevision++; });
  operations.onRetire(() => { sequence++; conversationIntent++; loading.set(false); busy.set(false); });
  const catalog = computed(() => assistantContacts(app.bots(), search()));
  const visibleIDs = signal(new Set<string>());
  const catalogAvailable = computed(() => capability()?.supported === true && capability()?.enabled === true && enabled() === true);
  const conversationAvailable = computed(() => {
    const owner = selected();
    return !!owner && !owner.retired && catalogAvailable()
      && app.bots().some(bot => bot.id === owner.bot.id && text(bot.effectiveWorkspacePath) === text(owner.bot.effectiveWorkspacePath));
  });
  const entries = computed(() => props.presentation !== 'desktop' && !catalogAvailable() ? [] : [
    ...(catalog().pinned ? [{ bot: catalog().pinned!, pinned: true }] : []),
    ...catalog().others.map(bot => ({ bot, pinned: false })),
  ]);
  const foreground = () => fence.current() && props.active !== false && app.tab() === 1 && lifecycle() === 'active';
  const interactive = () => foreground() && props.interactive !== false;
  effect(() => {
    app.bots(); selected();
    untracked(() => { if (pendingConversationCurrent && !pendingConversationCurrent()) conversationIntent++; });
  });
  effect(() => {
    const owner = selected(), bots = app.bots(), available = catalogAvailable(), canStart = interactive(), pending = conversationFlight();
    if (props.presentation !== 'desktop' || !owner) return;
    untracked(() => {
      const next = bots.find(bot => bot.id === owner.bot.id && text(bot.effectiveWorkspacePath) === text(owner.bot.effectiveWorkspacePath));
      if (!owner.retired && (!available || !next)) {
        // Terminal for this writer lifetime: even a restored identity cannot
        // revive an owner whose retirement may already have released its claim.
        conversationIntent++;
        selected.set({ ...owner, retired: true });
        return;
      }
      if (!owner.retired && next && (Object.keys(next).length !== Object.keys(owner.bot).length
        || Object.keys(next).some(key => next[key] !== owner.bot[key]))) selected.set({ ...owner, bot: { ...next } });
      if (owner.retired && canStart && !pending && retirementAttempted !== owner.serial) {
        retirementAttempted = owner.serial;
        void changeConversation(null, true);
      }
    });
  });
  const captureMutation = (): AssistantFence => {
    const operation = capture(), revision = interactionRevision;
    return { current: () => operation.current() && (props.presentation !== 'desktop' || interactive() && revision === interactionRevision), request: operation.request };
  };
  function mountConversation(bot: Row) {
    initiallySelected = true;
    selected.set({ serial: ++conversationSerial, bot: { ...bot }, retired: false });
  }
  async function changeConversation(targetID: string | null, retirement = false, originCurrent: () => boolean = () => true) {
    if (conversationFlight()) { if (!retirement) conversationIntent++; return false; }
    if (!originCurrent() || !interactive() || !retirement && !catalogAvailable()) return false;
    const intent = ++conversationIntent;
    const owner = selected(), snapshot = app.bots(), target = snapshot.find(bot => bot.id === targetID);
    if (retirement ? !owner?.retired : !target) return false;
    // Retiring a removed/disabled identity needs its original owner/Host, not
    // live catalog membership or the interactive lane being torn down.
    const operation = retirement ? null : captureMutation();
    const authority = desktopSidebarScope(app.connection(), epoch()), serial = owner?.serial;
    const targetDirectory = text(target?.effectiveWorkspacePath);
    let open = true, committed = false;
    const current = () => open && alive && originCurrent() && intent === conversationIntent && operations.displayCurrent()
      && authority === desktopSidebarScope(app.connection(), epoch()) && selected()?.serial === serial
      && (retirement ? selected()?.retired === true : operation?.current() === true && interactive() && catalogAvailable()
        && (!owner || owner.retired || conversationAvailable())
        && app.bots().some(bot => bot.id === targetID && text(bot.effectiveWorkspacePath) === targetDirectory));
    const apply = () => {
      if (committed || !current()) return;
      committed = true;
      if (retirement) selected.set(null);
      else {
        const next = app.bots().find(bot => bot.id === targetID && text(bot.effectiveWorkspacePath) === targetDirectory);
        if (next) mountConversation(next);
      }
    };
    conversationFlight.set(true);
    pendingConversationCurrent = current;
    try {
      if (!current()) return false;
      if (props.requestConversationChange) {
        const accepted = await props.requestConversationChange(apply, current);
        return accepted === true && committed;
      }
      if (!retirement) apply();
      return committed;
    } catch (failure) {
      if (current()) error.set(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally { open = false; pendingConversationCurrent = null; conversationFlight.set(false); }
  }
  function selectConversation(bot: Row) {
    const id = text(bot.id);
    if (id === selected()?.bot.id) { if (conversationFlight()) conversationIntent++; return; }
    void changeConversation(id);
  }
  const stopNavigation = props.onConversationNavigation?.(async (assistantID, current) => {
    if (!current() || !interactive() || !conversationAvailable()) return false;
    if (selected()?.bot.id === assistantID && !selected()?.retired) { conversationIntent++; return true; }
    if (!app.bots().some(bot => bot.id === assistantID)) {
      const intent = ++conversationIntent;
      await load(false);
      if (intent !== conversationIntent || !current() || !interactive() || !conversationAvailable()) return false;
    }
    return changeConversation(assistantID, false, current);
  });
  cleanup(() => { if (typeof stopNavigation === 'function') stopNavigation(); });
  function retry() {
    if (selected()?.retired && !conversationFlight()) void changeConversation(null, true);
    void load();
  }
  async function load(refreshCapability = true) {
    if (!operations.current()) return;
    const fence = capture();
    const sidebarScope = desktopSidebarScope(app.connection(), epoch());
    const attempt = ++sequence;
    loading.set(true);
    try {
      const cap = !refreshCapability && capability() && (props.presentation !== 'desktop' || capability()?.supported === true && capability()?.enabled === true)
        ? capability()! : await assistantRequest(fence, '/api/yuri/assistants/capability');
      if (!fence.current() || attempt !== sequence) return;
      capability.set(cap);
      if (typeof cap.supported !== 'boolean' || typeof cap.enabled !== 'boolean') throw new Error(t('assistants.state.unavailable'));
      if (cap.supported !== true || cap.enabled !== true) { enabled.set(false); error.set(''); return; }
      const snapshot = await readAssistantSnapshot(fence);
      if (!fence.current() || attempt !== sequence || Number(snapshot.revision) < revision) return;
      revision = Number(snapshot.revision);
      const bots = snapshotBots(snapshot);
      if (!adoptAssistantCatalogSnapshot(snapshot, sidebarScope)) return;
      enabled.set(snapshot.enabled === true); error.set('');
      if (props.presentation === 'desktop' && snapshot.enabled === true && !initiallySelected && selected() === null) {
        const initial = props.initialAssistantID ? bots.find(bot => bot.id === props.initialAssistantID) : bots[0];
        if (initial) mountConversation(initial);
        else if (props.initialAssistantID) error.set(t('common.unavailable'));
      }
    } catch (failure) {
      if (fence.current() && attempt === sequence) error.set(failure instanceof Error ? failure.message : String(failure));
    } finally { if (fence.current() && attempt === sequence) loading.set(false); }
  }
  effect(() => {
    const active = foreground();
    if (!active) { sequence++; loading.set(false); return; }
    untracked(() => { void load(); });
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      if (stopped || !foreground()) return;
      timer = setTimeout(async () => {
        if (stopped || !foreground()) return;
        if (!loading()) await load(false);
        if (stopped || !foreground()) return;
        next();
      }, app.bots().some(bot => bot.working === true || !!bot.activeContactTurn) ? 2500 : 15000);
    };
    untracked(next);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  });
  let tipTimer: ReturnType<typeof setTimeout> | undefined;
  const stopEvents = host.on('runtime.event', payload => {
    if (!foreground() || tipTimer) return;
    const event = runtimeEventFrom(payload);
    if (!event || event.key !== 'global' || !['assistants-changed', 'yuri:assistants-changed', 'contact-turn-start', 'contact-turn-end', 'yuri:contact-turn-start', 'yuri:contact-turn-end', 'event-stream-ready', 'yuri:event-stream-ready', 'reconnected'].includes(event.type)) return;
    tipTimer = setTimeout(() => { tipTimer = undefined; if (foreground()) void load(false); }, 120);
  });
  cleanup(() => { stopEvents(); if (tipTimer) clearTimeout(tipTimer); });
  async function perform(work: (fence: AssistantFence) => Promise<void>) {
    if (busy() || !fence.current() || props.presentation === 'desktop' && !interactive()) return;
    const captured = captureMutation();
    busy.set(true); error.set('');
    try { await work(captured); }
    catch (failure) { if (captured.current()) error.set(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (props.presentation === 'desktop' ? fence.current() : captured.current()) busy.set(false); }
  }
  async function remove(bot: Row, fence: AssistantFence = capture()) {
    const answer = await AlertDialog.show({ title: t('assistants.settings.delete'), description: t('assistants.settings.deleteConfirm', { name: text(bot.name) }), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'delete', label: t('assistants.settings.delete'), role: 'destructive' }] });
    if (!fence.current() || answer.action !== 'delete') return;
    await mutateAssistant(fence, bot, null);
    if (!fence.current()) return;
    sequence++; app.bots.set(app.bots().filter(item => item.id !== bot.id));
    await load();
    if (!fence.current()) return;
  }
  async function menu(bot: Row) {
    if (busy() || !operations.current()) return;
    const fence = capture();
    const answer = await AlertDialog.show({ title: text(bot.name), presentation: 'actionSheet', actions: [
      ...(bot.pinnedAt !== undefined ? [{ id: 'pin', label: t(bot.pinnedAt == null ? 'assistants.menu.pin' : 'assistants.menu.unpin') }] : []),
      { id: 'edit', label: t('assistants.menu.edit') },
      { id: 'delete', label: t('assistants.settings.delete'), role: 'destructive' },
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
    ] });
    if (!fence.current()) return;
    if (answer.action === 'edit') props.onEdit(bot);
    if (answer.action === 'delete') await perform(() => remove(bot));
    if (!fence.current()) return;
    if (answer.action === 'pin') await perform(async () => {
      const saved = await mutateAssistant(fence, bot, { pinned: bot.pinnedAt == null });
      if (!fence.current()) return;
      sequence++; app.bots.set(app.bots().map(item => item.id === bot.id ? { ...item, ...saved } : item));
      await load();
      if (!fence.current()) return;
    });
  }
  function relative(bot: Row) {
    const timestamp = record(bot.latestMessagePreview).createdAt;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return t('common.relative.justNow');
    if (minutes < 60) return t('common.relative.minutesAgoShort', { count: minutes });
    if (minutes < 1440) return t('common.relative.hoursAgoShort', { count: Math.floor(minutes / 60) });
    return t('common.relative.daysAgoShort', { count: Math.floor(minutes / 1440) });
  }
  function card(bot: Row, pinned = false) {
    return <AssistantSwipeRow id={text(bot.id)} name={text(bot.name)} pinned={pinned} disabled={busy() || !fence.current()} revealed={revealed()} onReveal={id => revealed.set(id)} onOpen={() => props.onOpenChat(assistantChatTarget(bot))} onEdit={() => props.onEdit(bot)} onDelete={() => { void perform(() => remove(bot)); }} onMenu={() => { void menu(bot); }}>
        <View class="items-center justify-center">
          <AssistantAvatar bot={bot} size={pinned ? 64 : 44} active={foreground() && visibleIDs().has(text(bot.id))} />
          <If when={bot.working === true || !!bot.activeContactTurn}><View class="absolute bottom-0 right-0 w-2 h-2 bg-primary rounded-full" accessibilityLabel={t('assistants.contact.working')} /></If>
        </View>
        <View class={pinned ? 'items-center gap-1' : 'flex-1 gap-1'}>
          <View class="flex-row items-center gap-2"><Text class="flex-1 text-base font-semibold text-foreground" style={{ numberOfLines: 1 }}>{text(bot.name)}</Text><If when={!pinned && !!relative(bot)}><Text class="text-xs text-muted-foreground">{relative(bot)}</Text></If></View>
          <If when={!pinned}><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{assistantPreview(bot, t)}</Text></If>
        </View>
        <If when={Number(bot.unreadCount) > 0}><View class="rounded-full bg-primary min-w-5 px-1 items-center justify-center" accessibilityLabel={t('assistants.unread.label', { count: Number(bot.unreadCount) })}><Text class="text-xs text-primary-foreground">{Number(bot.unreadCount) > 99 ? '99+' : String(bot.unreadCount)}</Text></View></If>
    </AssistantSwipeRow>;
  }
  if (props.presentation === 'desktop') {
    const workspaceState = () => resolveAssistantWorkspacePresentation({
      capabilityPending: capability() === null && !error(), snapshotPending: enabled() === null && !error(),
      capabilityError: !!error() && capability() === null,
      supported: capability()?.supported === true, capabilityEnabled: capability()?.enabled === true,
      snapshotEnabled: enabled() === true, snapshotSettled: enabled() !== null,
      assistantCount: app.bots().length, hasAssistant: !!desktopAssistant(),
    });
    const invoke = (action: () => void) => { if (interactive() && catalogAvailable() && !busy()) action(); };
    return <DesktopAssistantWorkspace state={workspaceState()} active={foreground()} interactive={interactive()} loading={loading()} busy={busy()} error={error()}
      conversationAdmission={{ key: selected()?.serial ?? 0, active: foreground() && conversationAvailable(), interactive: interactive() && conversationAvailable(), unavailable: selected()?.retired === true, catalogInteractive: catalogAvailable() }}
      entries={entries()} selected={desktopAssistant()} renderConversation={props.renderConversation} contactStatus={props.contactStatus} onOpenMiniChat={props.onOpenMiniChat ? bot => invoke(() => props.onOpenMiniChat?.(bot)) : undefined}
      onSelect={bot => invoke(() => selectConversation(bot))} onCreate={() => invoke(props.onCreate)} onEdit={bot => invoke(() => props.onEdit(bot))}
      onDelete={bot => { void perform(operation => remove(bot, operation)); }} onPin={bot => { void perform(async operation => {
        const saved = await mutateAssistant(operation, bot, { pinned: bot.pinnedAt == null });
        if (!operation.current()) return;
        sequence++; app.bots.set(app.bots().map(item => item.id === bot.id ? { ...item, ...saved } : item));
        await load();
      }); }} onMarkAllRead={() => { void perform(async operation => {
        const failed = await markAssistantCatalogRead(operation, app.bots());
        if (!operation.current()) return;
        await load();
        if (operation.current() && failed) throw new Error(t('assistants.unread.markAllFailed'));
      }); }} onRetry={() => { if (interactive() && !busy()) retry(); }} />;
  }
  return <View class="flex-1 bg-background" testID="assistant-home">
    <View class="flex-row items-center px-5 pt-5 pb-8 gap-2">
      <Text class="flex-1 text-3xl font-bold text-foreground">{t('assistants.title')}</Text>
      <Button testID="assistant-toggle-search" class={small} accessibilityLabel={t('chat.timeline.searchPlaceholder')} onPress={() => searching.set(!searching())}><Icon name="search" /></Button>
      <If when={app.bots().some(bot => Number(bot.unreadCount) > 0)}><Button class={small} disabled={busy()} accessibilityLabel={t('assistants.unread.markAll')} onPress={() => { void perform(async fence => {
        const failed = await markAssistantCatalogRead(fence, app.bots());
        if (!fence.current()) return;
        await load();
        if (!fence.current()) return;
        if (failed) throw new Error(t('assistants.unread.markAllFailed'));
      }); }}><Icon name="check-double" /></Button></If>
      <Button class={small} disabled={capability()?.supported !== true || enabled() !== true} accessibilityLabel={t('assistants.settings.create')} onPress={props.onCreate}><Icon name="add" /></Button>
    </View>
    <If when={searching()}><Input testID="assistant-search" class="mx-5 mb-4 p-3 bg-secondary rounded-xl text-foreground" value={search()} onChange={event => search.set(event.value)} accessibilityLabel={t('chat.timeline.searchPlaceholder')} placeholder={t('chat.timeline.searchPlaceholder')} /></If>
    <If when={!!error()}><View class="px-5 pb-3 gap-2"><Text class="text-destructive">{error()}</Text><Button onPress={() => { void load(); }}><Text class="text-foreground">{t('assistants.actions.retry')}</Text></Button></View></If>
    <If when={capability()?.supported === false || enabled() === false}><View class="mx-5 p-5 rounded-3xl bg-card gap-3"><Icon name="ai-agent" size={32} /><Text class="text-xl text-foreground">{t(capability()?.supported === false ? 'assistants.state.unsupportedTitle' : 'assistants.guide.disabledTitle')}</Text><Text class="text-muted-foreground">{t(capability()?.supported === false ? 'assistants.state.unsupportedDescription' : 'assistants.guide.disabledDescription')}</Text><If when={capability()?.supported === true && !!props.onOpenSettings}><Button onPress={props.onOpenSettings}><Text class="text-foreground">{t('assistants.guide.enableAction')}</Text></Button></If></View></If>
    <List testID="assistant-catalog" class="flex-1" contentClass="px-5 gap-3 pb-8" each={entries()} keyExtractor={entry => text(entry.bot.id)} refreshing={loading()} onRefresh={() => { revealed.set(null); void load(); }} onViewableItemsChange={info => {
      const next = new Set(info.viewableItems.filter(item => item.isViewable).map(item => text(item.item.bot.id)));
      if (next.size !== visibleIDs().size || [...next].some(id => !visibleIDs().has(id))) visibleIDs.set(next);
    }} viewabilityConfig={{ itemVisibleThreshold: 0.01 }}
      empty={<If when={!loading() && !error() && enabled() === true && !catalog().pinned}><If when={!!search().trim()} else={<View class="p-5 gap-3 bg-card rounded-3xl"><Icon name="ai-agent" size={24} /><Text class="text-xl text-foreground">{t('assistants.onboarding.title')}</Text><Text class="text-muted-foreground">{t('assistants.onboarding.description')}</Text><Button class="p-3 bg-secondary rounded-xl" onPress={props.onCreate}><Text class="text-foreground">{t('assistants.onboarding.action')}</Text></Button></View>}><Text class="text-muted-foreground p-5">{t('commandPalette.empty.noResults')}</Text></If></If>}>
      {entry => card(entry().bot, entry().pinned)}
    </List>
  </View>;
}
