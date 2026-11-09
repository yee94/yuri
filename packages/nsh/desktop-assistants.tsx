import { effect, List, locale, signal, Text, View, windowSize, type JSX } from 'nsh';
import { Button, ContextMenu, MenuItem, MenuSeparator, Tooltip } from 'nsh/base';
import { AssistantAvatar } from './assistants-avatar-live';
import { assistantPreview } from './assistants-core';
import { Icon } from './Icon';
import { language, t } from './i18n';
import { record, text, type Row } from './model';
import { createContactTimeFormatter } from '../ui/src/components/assistants/contactMessageTime';

export type DesktopAssistantConversationContext = {
  /** Accessors stay live without recreating the selected conversation owner. */
  bot: () => Row;
  active: () => boolean;
  interactive: () => boolean;
};
export type DesktopAssistantPresentation = {
  renderConversation?: (context: DesktopAssistantConversationContext) => JSX.Element;
  /** The shell owns the actual native secondary-window capability. */
  onOpenMiniChat?: (bot: Row) => void;
  /** Optional authoritative status from the same selected conversation owner. */
  contactStatus?: (bot: Row) => string | undefined;
};
type Props = DesktopAssistantPresentation & {
  active: boolean; interactive: boolean; loading: boolean; busy: boolean;
  conversationAdmission?: { key: number; active: boolean; interactive: boolean; unavailable: boolean; catalogInteractive: boolean };
  state: 'loading' | 'unavailable' | 'onboarding' | 'ready'; error: string;
  entries: Array<{ bot: Row; pinned: boolean }>; selected: Row | null;
  onSelect: (bot: Row) => void; onCreate: () => void; onEdit: (bot: Row) => void;
  onDelete: (bot: Row) => void; onPin: (bot: Row) => void;
  onMarkAllRead: () => void; onRetry: () => void;
};
const iconButton = 'size-8 shrink-0 rounded-md items-center justify-center hover:bg-accent focus:bg-accent active:bg-accent disabled:opacity-40';
const actionButton = 'h-8 px-3 rounded-md bg-secondary items-center justify-center hover:bg-accent focus:bg-accent active:bg-accent disabled:opacity-40';
const menuClass = 'min-w-40 bg-card border border-border rounded-lg p-1 shadow-lg';
const menuItem = 'flex-row items-center gap-2 px-2 py-2 rounded-md hover:bg-secondary focus:bg-accent active:bg-accent disabled:opacity-40';

/** Presentation only. AssistantHome remains the sole catalog/read/mutation owner. */
export function DesktopAssistantWorkspace(props: Props) {
  const menu = signal(''), visibleIDs = signal(new Set<string>());
  const can = () => props.active && props.interactive && !props.busy;
  const canCatalog = () => can() && props.conversationAdmission?.catalogInteractive !== false;
  const canConversation = () => canCatalog() && props.conversationAdmission?.interactive !== false && props.conversationAdmission?.unavailable !== true;
  const invoke = (work: () => void) => { if (canCatalog()) work(); };
  effect(() => { if (!props.active || !props.interactive) menu.set(''); });
  const unread = () => props.entries.some(entry => Number(entry.bot.unreadCount) > 0);
  const canMarkRead = () => props.entries.some(entry => Number(entry.bot.unreadCount) > 0 && typeof record(entry.bot.readTip).generation === 'number');
  function Badge(item: { bot: Row }) {
    return <If when={Number(item.bot.unreadCount) > 0}><View class="rounded-full bg-primary min-w-3.5 px-1 items-center justify-center" accessibilityLabel={t('assistants.unread.label', { count: Number(item.bot.unreadCount) })}>
      <Text class="text-primary-foreground" style={{ fontSize: 10 }}>{Number(item.bot.unreadCount) > 99 ? '99+' : String(item.bot.unreadCount)}</Text>
    </View></If>;
  }
  function Contact(item: { bot: Row; pinned: boolean }) {
    const selected = () => props.selected?.id === item.bot.id;
    return <View class={item.pinned ? 'items-center pt-2 pb-3' : 'pt-1'}>
      <ContextMenu class={item.pinned ? 'w-full max-w-28' : 'w-full'} open={canCatalog() && menu() === text(item.bot.id)} onOpenChange={event => menu.set(event.open && canCatalog() ? text(item.bot.id) : '')} popupClass={menuClass} trigger={
        <Button testID={`desktop-assistant-${text(item.bot.id)}`} role="option" selected={selected()} disabled={!canCatalog()} accessibilityLabel={text(item.bot.name)}
          class={item.pinned ? `w-full items-center gap-2 rounded-2xl px-2 py-3 hover:bg-accent focus:bg-accent active:bg-accent ${selected() ? 'bg-muted' : ''}` : `w-full flex-row items-center gap-3 rounded-xl border px-3 py-3 hover:bg-accent focus:bg-accent active:bg-accent ${selected() ? 'border-border bg-card' : 'border-transparent'}`}
          onPress={() => invoke(() => props.onSelect(item.bot))}>
          <View><AssistantAvatar bot={item.bot} size={item.pinned ? 64 : 44} active={props.active && props.interactive && visibleIDs().has(text(item.bot.id))} />
            <If when={item.pinned}><View class="absolute right-0 top-0"><Badge bot={item.bot} /></View></If>
          </View>
          <View class={item.pinned ? 'w-full items-center' : 'flex-1 min-w-0 gap-1'}>
            <Text class={`text-sm text-foreground ${selected() ? 'font-semibold' : 'font-medium'}`} style={{ numberOfLines: 1 }}>{text(item.bot.name)}</Text>
            <If when={!item.pinned}><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{assistantPreview(item.bot, t)}</Text></If>
          </View>
          <If when={!item.pinned}><Badge bot={item.bot} /></If>
        </Button>
      }>
        <If when={item.bot.pinnedAt !== undefined}><MenuItem class={menuItem} disabled={!canCatalog()} onSelect={() => invoke(() => props.onPin(item.bot))}><Icon name={item.bot.pinnedAt == null ? 'pushpin-2' : 'unpin'} size={16} /><Text class="text-sm text-foreground">{t(item.bot.pinnedAt == null ? 'assistants.menu.pin' : 'assistants.menu.unpin')}</Text></MenuItem></If>
        <MenuItem class={menuItem} disabled={!canCatalog() || !props.onOpenMiniChat} onSelect={() => invoke(() => props.onOpenMiniChat?.(item.bot))}><Icon name="external-link" size={16} /><Text class="text-sm text-foreground">{t('sessions.sidebar.session.menu.openMiniChatWindow')}</Text></MenuItem>
        <MenuItem class={menuItem} disabled={!canCatalog()} onSelect={() => invoke(() => props.onEdit(item.bot))}><Icon name="edit" size={16} /><Text class="text-sm text-foreground">{t('assistants.menu.edit')}</Text></MenuItem>
        <MenuSeparator class="h-px my-1 bg-border" />
        <MenuItem class={menuItem} disabled={!canCatalog()} onSelect={() => invoke(() => props.onDelete(item.bot))}><Icon name="delete-bin" size={16} /><Text class="text-sm text-destructive">{t('assistants.settings.delete')}</Text></MenuItem>
      </ContextMenu>
    </View>;
  }
  function Conversation(item: { bot: Row }) {
    const status = () => {
      if (props.conversationAdmission?.unavailable) return t('assistants.state.unavailable');
      if (item.bot.working === true || !!item.bot.activeContactTurn) return t('assistants.conversation.typing');
      const authoritative = props.contactStatus?.(item.bot); if (authoritative) return authoritative;
      const timestamp = record(item.bot.latestMessagePreview).createdAt;
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return t('common.unavailable');
      const formatter = createContactTimeFormatter(language() === 'system' ? locale() : language(), t('common.date.today'), new Date());
      return t('assistants.conversation.lastContact', { time: formatter(timestamp) });
    };
    return <View testID={`desktop-assistant-conversation-${text(item.bot.id)}`} class="flex-1 min-w-0 min-h-0 border-l border-border">
      <View class="flex-row items-center gap-3.5 px-7 border-b border-border" style={{ height: 64, flexShrink: 0 }}>
        <AssistantAvatar bot={item.bot} size={40} active={props.active && props.interactive} />
        <View class="flex-1 min-w-0 gap-1"><Text testID="desktop-assistant-title" class="text-sm font-semibold text-foreground" style={{ numberOfLines: 1 }}>{text(item.bot.name)}</Text><Text testID="desktop-assistant-status" class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{status()}</Text></View>
        <Button testID="desktop-assistant-mini-chat" class={iconButton} disabled={!canConversation() || !props.onOpenMiniChat} accessibilityLabel={t('sessions.sidebar.session.menu.openMiniChatWindow')}
          tooltip={<Tooltip class="bg-card border border-border rounded-md px-2 py-1"><Text class="text-xs text-foreground">{t(props.onOpenMiniChat ? 'sessions.sidebar.session.menu.openMiniChatWindow' : 'common.unavailable')}</Text></Tooltip>}
          onPress={() => { if (canConversation()) invoke(() => props.onOpenMiniChat?.(item.bot)); }}><Icon name="external-link" size={16} /></Button>
        <Button testID="desktop-assistant-settings" class={iconButton} disabled={!canConversation()} accessibilityLabel={t('assistants.conversation.openSettings')} onPress={() => { if (canConversation()) invoke(() => props.onEdit(item.bot)); }}><Icon name="settings-3" size={16} /></Button>
      </View>
      <ConversationBody bot={item.bot} />
    </View>;
  }
  function ConversationBody(item: { bot: Row }) {
    // Invoke the shell factory once per selected identity; live accessors do not
    // rebuild the Chat owner when a snapshot or a temporary Dialog changes.
    return props.renderConversation?.({ bot: () => item.bot, active: () => props.conversationAdmission?.active ?? props.active, interactive: () => props.conversationAdmission?.interactive ?? props.interactive })
      ?? <View testID="desktop-assistant-conversation-unavailable" class="flex-1 items-center justify-center"><Text class="text-sm text-muted-foreground">{t('assistants.state.unavailable')}</Text></View>;
  }
  function State(state: { feedback?: boolean }) {
    return <View testID={`desktop-assistants-${props.state}`} accessibilityLabel={props.state === 'loading' ? t('common.loading') : undefined} class="flex-1 items-center justify-center px-6 gap-4">
      <Icon name={props.state === 'loading' ? 'loader-4' : props.state === 'onboarding' ? 'ai-agent' : 'cloud-off'} size={24} />
      <If when={props.state !== 'loading'}><Text class="text-base font-semibold text-foreground">{t(props.state === 'onboarding' ? 'assistants.onboarding.title' : 'assistants.state.unavailable')}</Text></If>
      <If when={props.state === 'onboarding'}><Text class="text-sm text-muted-foreground" style={{ maxWidth: 448 }}>{t('assistants.onboarding.description')}</Text><Button testID="desktop-assistant-create" class={actionButton} disabled={!canCatalog()} onPress={() => invoke(props.onCreate)}><Text class="text-sm text-foreground">{t('assistants.onboarding.action')}</Text></Button></If>
      <If when={state.feedback !== false && !!props.error}><Text role="alert" class="text-sm text-destructive">{props.error}</Text><Button testID="desktop-assistants-retry" class={actionButton} disabled={!can() || props.loading} onPress={() => { if (can()) props.onRetry(); }}><Text class="text-sm text-foreground">{t('assistants.actions.retry')}</Text></Button></If>
    </View>;
  }
  return <View testID="desktop-assistants-workspace" class="flex-1 min-h-0 min-w-0 bg-background" disabled={!props.interactive}>
    <If when={props.state === 'ready' || !!props.selected || props.state !== 'loading' && props.entries.length > 0} else={<State />}>
      <View class="flex-1 flex-row min-h-0 min-w-0">
        <View testID="desktop-assistants-contacts" class="min-h-0" style={{ width: Math.min(320, Math.max(256, windowSize().width * .22)), flexShrink: 0 }}>
          <View class="flex-row items-center gap-3 px-5 pt-4 pb-1">
            <Text class="text-sm font-semibold text-foreground">{t('assistants.title')}</Text><View class="flex-1" />
            <Button testID="desktop-assistants-mark-read" class={iconButton} style={{ opacity: unread() ? 1 : 0 }} disabled={!canCatalog() || !canMarkRead()} accessibilityLabel={t('assistants.unread.markAll')} onPress={() => invoke(props.onMarkAllRead)}><Icon name="check-double" size={16} /></Button>
            <Button testID="desktop-assistant-create" class={`${iconButton} bg-card border border-border`} disabled={!canCatalog()} accessibilityLabel={t('assistants.settings.create')} onPress={() => invoke(props.onCreate)}><Icon name="add" size={16} /></Button>
          </View>
          <If when={!!props.error || props.conversationAdmission?.unavailable}><View class="px-4 gap-2"><Text role="alert" class="text-xs text-muted-foreground">{t(props.conversationAdmission?.unavailable ? 'assistants.state.unavailable' : 'assistants.state.staleSnapshot')}</Text><If when={!!props.error}><Text class="text-xs text-destructive">{props.error}</Text></If><Button testID="desktop-assistants-retry" class={actionButton} disabled={!can() || props.loading} onPress={() => { if (can()) props.onRetry(); }}><Text class="text-xs text-foreground">{t('assistants.actions.retry')}</Text></Button></View></If>
          <List testID="desktop-assistants-list" role="listbox" accessibilityLabel={t('assistants.listAria')} class="flex-1 min-h-0" contentClass="px-4 pb-4" each={props.entries} keyExtractor={entry => text(entry.bot.id)}
            onViewableItemsChange={info => { const next = new Set(info.viewableItems.filter(item => item.isViewable).map(item => text(item.item.bot.id))); if (next.size !== visibleIDs().size || [...next].some(id => !visibleIDs().has(id))) visibleIDs.set(next); }} viewabilityConfig={{ itemVisibleThreshold: .01 }}>
            {entry => <Contact bot={entry().bot} pinned={entry().pinned} />}
          </List>
        </View>
        <Each of={props.selected ? [props.selected] : []} key={bot => props.conversationAdmission?.key ?? text(bot.id)}>{bot => <Conversation bot={bot()} />}</Each>
        <If when={!props.selected}><State feedback={false} /></If>
      </View>
    </If>
  </View>;
}
