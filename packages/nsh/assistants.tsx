import { cleanup, computed, effect, host, lifecycle, List, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button, Input } from 'nsh/base';
import { nativeDensity } from './appearance';
import { t } from './i18n';
import { Icon } from './Icon';
import { record, runtimeEventFrom, text, type ChatTarget, type Row } from './model';
import { app, epoch } from './state';
import { createPageOperations } from './page-operations';
import { assistantContacts, assistantPreview, assistantRequest, markAssistantCatalogRead, mutateAssistant, readAssistantSnapshot, snapshotBots, type AssistantFence } from './assistants-core';
import { AssistantSwipeRow } from './assistants-swipe';
import { AssistantAvatar } from './assistants-avatar-live';

export { AssistantDetails } from './assistants-details';
export { AssistantSettings } from './assistants-settings';
export { AssistantAvatar } from './assistants-avatar-live';
export const assistantChatTarget = (bot: Row): ChatTarget => ({ kind: 'assistant', id: text(bot.id), title: text(bot.name), directory: text(bot.effectiveWorkspacePath) });
const small = 'h-10 w-10 rounded-full bg-secondary items-center justify-center active:bg-accent disabled:opacity-40';
export type AssistantHomeProps = {
  onOpenChat: (target: ChatTarget) => void;
  onCreate: () => void;
  onEdit: (bot: Row) => void;
  onOpenSettings?: () => void;
  active?: boolean;
  bottomInset?: number;
};
export function AssistantHome(props: AssistantHomeProps) {
  const operations = createPageOperations(() => props.active !== false && app.tab() === 1);
  let alive = true, sequence = 0, revision = -1;
  cleanup(() => { alive = false; sequence++; });
  const fence = { current: () => alive && operations.current() };
  const capture = (): AssistantFence => { const lane = operations.capture(); return { current: () => alive && lane.current(), request: lane.request }; };
  const loading = signal(false), busy = signal(false), error = signal(''), search = signal(''), searching = signal(false), capability = signal<Row | null>(null), enabled = signal<boolean | null>(null);
  const revealed = signal<string | null>(null);
  operations.onRetire(() => { sequence++; loading.set(false); busy.set(false); });
  const catalog = computed(() => assistantContacts(app.bots(), search()));
  const visibleIDs = signal(new Set<string>());
  const entries = computed(() => capability()?.supported !== true || capability()?.enabled !== true || enabled() !== true ? [] : [
    ...(catalog().pinned ? [{ bot: catalog().pinned!, pinned: true }] : []),
    ...catalog().others.map(bot => ({ bot, pinned: false })),
  ]);
  const foreground = () => fence.current() && props.active !== false && app.tab() === 1 && lifecycle() === 'active';
  async function load(refreshCapability = true) {
    if (!operations.current()) return;
    const fence = capture();
    const attempt = ++sequence;
    loading.set(true);
    try {
      const cap = !refreshCapability && capability() ? capability()! : await assistantRequest(fence, '/api/yuri/assistants/capability');
      if (!fence.current() || attempt !== sequence) return;
      capability.set(cap);
      if (typeof cap.supported !== 'boolean' || typeof cap.enabled !== 'boolean') throw new Error(t('assistants.state.unavailable'));
      if (cap.supported !== true || cap.enabled !== true) { enabled.set(false); error.set(''); return; }
      const snapshot = await readAssistantSnapshot(fence);
      if (!fence.current() || attempt !== sequence || Number(snapshot.revision) < revision) return;
      revision = Number(snapshot.revision);
      enabled.set(snapshot.enabled === true); app.bots.set(snapshotBots(snapshot)); error.set('');
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
    if (busy() || !fence.current()) return;
    const captured = capture();
    busy.set(true); error.set('');
    try { await work(captured); }
    catch (failure) { if (captured.current()) error.set(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (captured.current()) busy.set(false); }
  }
  async function remove(bot: Row) {
    const fence = capture();
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
  function card(entry: () => { bot: Row; pinned: boolean }) {
    const bot = () => entry().bot, pinned = () => entry().pinned;
    return <AssistantSwipeRow binding={entry()} generation={epoch()} id={text(bot().id)} name={text(bot().name)} pinned={pinned()} disabled={busy() || !fence.current()} revealed={revealed()} onReveal={id => revealed.set(id)} onOpen={() => props.onOpenChat(assistantChatTarget(bot()))} onEdit={() => props.onEdit(bot())} onDelete={() => { const current = bot(); void perform(() => remove(current)); }} onMenu={() => { void menu(bot()); }}>
        <View class="items-center justify-center">
          <AssistantAvatar bot={bot()} size={pinned() ? 64 : 44} active={foreground() && visibleIDs().has(text(bot().id))} />
          <If when={bot().working === true || !!bot().activeContactTurn}><View class="absolute bottom-0 right-0 w-2 h-2 bg-primary rounded-full" accessibilityLabel={t('assistants.contact.working')} /></If>
        </View>
        <View class={pinned() ? 'items-center gap-1' : 'flex-1 gap-1'} style={pinned() ? { width: 96, minWidth: 0, maxWidth: 96 } : undefined}>
          <View class="flex-row items-center gap-2" style={pinned() ? { width: '100%', minWidth: 0 } : undefined}><Text class={pinned() ? 'text-base font-semibold text-foreground' : 'flex-1 text-base font-semibold text-foreground'} style={pinned() ? { width: '100%', minWidth: 0, textAlign: 'center', numberOfLines: 1, textOverflow: 'ellipsis' } : { numberOfLines: 1 }}>{text(bot().name)}</Text><If when={!pinned() && !!relative(bot())}><Text class="text-xs text-muted-foreground">{relative(bot())}</Text></If></View>
          <If when={!pinned()}><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{assistantPreview(bot(), t)}</Text></If>
        </View>
        <If when={Number(bot().unreadCount) > 0}><View class="rounded-full bg-primary min-w-5 px-1 items-center justify-center" accessibilityLabel={t('assistants.unread.label', { count: Number(bot().unreadCount) })}><Text class="text-xs text-primary-foreground">{Number(bot().unreadCount) > 99 ? '99+' : String(bot().unreadCount)}</Text></View></If>
    </AssistantSwipeRow>;
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
    <List testID="assistant-catalog" class="flex-1" contentClass="px-5 gap-3 pb-8" contentStyle={{ ...nativeDensity().pages.assistantCatalog, paddingBottom: (props.bottomInset ?? 0) + 32 * nativeDensity().scale }} each={entries()} keyExtractor={entry => text(entry.bot.id)} refreshing={loading()} onRefresh={() => { revealed.set(null); void load(); }} onViewableItemsChange={info => {
      const next = new Set(info.viewableItems.filter(item => item.isViewable).map(item => text(item.item.bot.id)));
      if (next.size !== visibleIDs().size || [...next].some(id => !visibleIDs().has(id))) visibleIDs.set(next);
    }} viewabilityConfig={{ itemVisibleThreshold: 0.01 }}
      empty={<If when={!loading() && !error() && enabled() === true && !catalog().pinned}><If when={!!search().trim()} else={<View class="p-5 gap-3 bg-card rounded-3xl"><Icon name="ai-agent" size={24} /><Text class="text-xl text-foreground">{t('assistants.onboarding.title')}</Text><Text class="text-muted-foreground">{t('assistants.onboarding.description')}</Text><Button class="p-3 bg-secondary rounded-xl" onPress={props.onCreate}><Text class="text-foreground">{t('assistants.onboarding.action')}</Text></Button></View>}><Text class="text-muted-foreground p-5">{t('commandPalette.empty.noResults')}</Text></If></If>}>
      {entry => card(entry)}
    </List>
  </View>;
}
