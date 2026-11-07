import { cleanup, colorScheme, effect, Image, lifecycle, safeArea, Scroll, signal, Text, token, untracked, View, windowSize } from 'nsh';
import { Button, Toggle } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { createPageOperations, type PageOperation } from './page-operations';
import { type ChatTarget } from './model';
import { createChatHeaderMetadata, type ChatHeaderMetadata } from './chat-header-metadata';
import { HeaderQuotaPanel } from './chat-header-quota-ui';
import { formatContextTokens } from '../ui/src/mobile/chat/mobileContextUsage';
import yuriDark from '../ui/src/lib/theme/themes/yuri-2-dark.json';
import yuriLight from '../ui/src/lib/theme/themes/yuri-2-light.json';
import { chatHeaderLayout, chatMetadataGeometry } from './chat-header-layout';
import { ChatHeaderPopup } from './chat-header-popup';

const circle = 'rounded-full bg-secondary border border-border items-center justify-center active:bg-accent';
const circleSize = { width: chatHeaderLayout.button, height: chatHeaderLayout.button };

function contextColor(percentage?: number): string {
  if (percentage === undefined) return String(token('muted-foreground'));
  if (percentage >= .9) return String(token('destructive'));
  // Native's current token schema has no warning entry; consume Yuri's owning semantic token.
  if (percentage >= .75) return (colorScheme() === 'dark' ? yuriDark : yuriLight).colors.status.warning;
  return String(token('success'));
}

export function ChatHeaderBack(props: { onPress: () => void }) {
  return <Button testID="chat-header-back" class={circle} style={circleSize} accessibilityLabel={t('header.actions.backAria')} onPress={props.onPress}><Icon name="arrow-left-s" size={20} /></Button>;
}

export function ChatHeaderTitle(props: { title: string }) {
  return <Text testID="chat-header-title" class="w-full text-base font-semibold text-foreground text-center" style={{ numberOfLines: 1 }}>{props.title}</Text>;
}

/** Desktop/headless fallback; mobile uses the system title and back button. */
export type HeaderAutoRead = { preferred: boolean; available: boolean; onToggle: () => void };
export function NativeChatHeader(props: { target: ChatTarget; active: boolean; busy: boolean; current: () => boolean; operation?: () => PageOperation | null; autoRead?: HeaderAutoRead; onBack: () => void; onOptions: (option: ChatHeaderOption) => void }) {
  const layout = chatHeaderLayout;
  return <View testID="chat-header-root" class="shrink-0 bg-background" style={{ paddingTop: safeArea().top + layout.top, paddingLeft: Math.max(layout.edge, safeArea().left), paddingRight: Math.max(layout.edge, safeArea().right) }}>
    <View testID="chat-header-row" class="flex-row items-center" style={{ height: layout.contentHeight, gap: layout.columnGap }}>
      <View class="items-start justify-center" style={{ width: layout.leadingColumn }}><ChatHeaderBack onPress={props.onBack} /></View>
      <View class="flex-1 min-w-0 items-center justify-center" style={{ paddingLeft: layout.titleInset, paddingRight: layout.titleInset }}><ChatHeaderTitle title={props.target.title} /></View>
      <ChatHeaderActions target={props.target} active={props.active} busy={props.busy} current={props.current} operation={props.operation} autoRead={props.autoRead} onOptions={props.onOptions} />
    </View>
  </View>;
}

/** Real measured context only. Unknown/pending is an open neutral track, not zero. */
function ContextRing(props: { metadata: ChatHeaderMetadata }) {
  const source = () => {
    const value = props.metadata;
    const measured = !value.pending && !value.contextStale && value.tokens !== undefined && value.limit !== undefined;
    const percentage = measured ? Math.min(1, value.tokens! / value.limit!) : undefined;
    const color = contextColor(percentage);
    const track = String(token('border'));
    const circumference = 50.265;
    const arc = percentage === undefined ? 12 : circumference * percentage;
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="8" fill="none" stroke="${track}" stroke-width="3"/><circle cx="11" cy="11" r="8" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${arc} ${circumference}" transform="rotate(-90 11 11)"/></svg>`);
  };
  return <Image src={source()} style={{ width: 22, height: 22 }} />;
}

export type ChatHeaderOption = 'new-session' | 'files' | 'changes' | 'mcp' | 'selection' | 'refresh' | 'auto-read' | 'remote-desktop';

export function ChatHeaderActions(props: { native?: boolean; target: ChatTarget; active: boolean; busy: boolean; current: () => boolean; operation?: () => PageOperation | null; autoRead?: HeaderAutoRead; onError?: (error: unknown) => void; onOptions: (option: ChatHeaderOption) => void }) {
  const own = props.operation ? undefined : createPageOperations(props.current);
  const operation = props.operation ?? own!.operation;
  const metadata = signal<ChatHeaderMetadata>({ loading: false, errors: [] }), open = signal(false), menu = signal(false);
  const current = () => props.current() && operation()?.current() === true && props.active && lifecycle() === 'active';
  let controller: ReturnType<typeof createChatHeaderMetadata> | undefined, assigned: PageOperation | null | undefined;
  cleanup(() => controller?.dispose());
  effect(() => {
    const lane = operation();
    if (lane !== assigned) {
      controller?.dispose(); controller = undefined; assigned = lane;
      open.set(false); menu.set(false);
      if (lane) controller = createChatHeaderMetadata({ target: props.target, current: () => assigned === lane && lane.current() && props.current() && props.active && lifecycle() === 'active', read: lane.request, changed: value => { if (assigned === lane && lane.current()) metadata.set(value); } });
    }
    const visible = props.active && lifecycle() === 'active', busy = props.busy;
    if (!visible) { open.set(false); menu.set(false); controller?.cancel(); return; }
    if (!busy) untracked(() => { void controller?.refresh(); });
  });
  function showMetadata(value: boolean) { if (current()) { open.set(value); if (value) { menu.set(false); void controller?.refresh(); void controller?.refreshQuotas(); } } }
  function select(option: ChatHeaderOption) { if (current()) { menu.set(false); props.onOptions(option); } }
  const contextLabel = () => metadata().pending ? t('contextUsage.pending') : metadata().tokens === undefined ? t('common.unavailable') : `${formatContextTokens(metadata().tokens!)}/${metadata().limit === undefined ? '—' : formatContextTokens(metadata().limit!)}`;
  const percentage = () => metadata().tokens !== undefined && metadata().limit !== undefined && !metadata().pending ? `${(metadata().tokens! / metadata().limit! * 100).toFixed(1)}%` : '';
  const panel = () => chatMetadataGeometry(windowSize().width, windowSize().height, safeArea().top, safeArea().bottom);
  const buttonClass = () => props.native ? 'rounded-full items-center justify-center active:bg-accent' : circle;
  const buttonSize = () => props.native ? { width: 32, height: 32 } : circleSize;
  return <View class="flex-row items-center shrink-0" style={{ gap: chatHeaderLayout.actionGap, height: props.native ? 32 : chatHeaderLayout.button }}>
    <If when={props.target.kind === 'session'}><ChatHeaderPopup native={props.native} anchorID="chat-header-metadata" current={current} onError={error => props.onError?.(error)} open={open()} placement="bottom" align="end" offset={panel().offset} margin={panel().margin} popupClass="bg-card rounded-[20px] p-2" popupStyle={{ width: panel().width, maxHeight: panel().maxHeight }}
      onOpenChange={event => showMetadata(event.open)} trigger={onPress => <Button onPress={onPress} testID="chat-header-metadata" class={buttonClass()} style={buttonSize()} accessibilityLabel={t('mobile.header.openMetadataAria')}><ContextRing metadata={metadata()} /></Button>}>
      <Scroll testID="chat-metadata-panel" style={{ maxHeight: panel().scrollMaxHeight }} contentClass="gap-1">
      <View class="flex-row items-center gap-3 px-3 py-3"><Icon name="git-branch" size={18} /><Text class="text-sm text-muted-foreground">{t('mobile.header.metadata.branch')}</Text><Text class="text-sm font-semibold text-foreground flex-1 text-right" style={{ numberOfLines: 1 }}>{metadata().branch || t(metadata().repository ? 'gitView.branch.detachedHead' : 'common.unavailable')}</Text></View>
      <View class="flex-row items-center gap-3 px-3 py-3"><ContextRing metadata={metadata()} /><Text class="text-sm text-muted-foreground">{t('mobile.header.metadata.context')}</Text><View class="flex-row flex-1 items-baseline justify-end gap-2"><Text class="text-sm font-semibold" style={{ color: contextColor(metadata().contextStale || metadata().pending || metadata().tokens === undefined || metadata().limit === undefined ? undefined : metadata().tokens! / metadata().limit!) }}>{percentage()}</Text><Text testID="chat-metadata-context" class="text-sm text-muted-foreground">{contextLabel()}</Text></View></View>
      <If when={!metadata().loading && !!metadata().model && metadata().limit === undefined}><Text class="text-sm text-muted-foreground">{t('chat.modelControls.metadataUnavailable')}</Text></If>
      <If when={metadata().loading}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If>
      <Each of={metadata().errors}>{error => <Text class="text-sm text-destructive">{error()}</Text>}</Each>
      <HeaderQuotaPanel snapshot={metadata().quota} onRefresh={() => { void controller?.refresh(true); void controller?.refreshQuotas(true); }} />
      </Scroll>
    </ChatHeaderPopup></If>
    <ChatHeaderPopup native={props.native} anchorID="chat-header-options" current={current} onError={error => props.onError?.(error)} open={menu()} placement="bottom" align="end" offset={8} margin={16} popupClass="bg-card rounded-2xl border border-border" popupStyle={{ width: 220 }} onOpenChange={event => { if (current()) { menu.set(event.open); if (event.open) open.set(false); } }}
      trigger={onPress => <Button onPress={onPress} testID="chat-header-options" class={buttonClass()} style={buttonSize()} accessibilityLabel={t('mobile.menu.titleAria')}><Icon name="more" size={20} /></Button>}>
      <WorkspaceAction id="new-session" label={t('mobile.menu.newSession')} icon="chat-new" select={select} />
      <WorkspaceAction id="files" label={t('mobile.menu.files')} icon="file-text" select={select} />
      <WorkspaceAction id="changes" label={t('mobile.menu.changes')} icon="git-branch" dirty={metadata().dirty} select={select} />
      <WorkspaceAction id="mcp" label={t('mobile.menu.mcp')} icon="plug" select={select} />
      <WorkspaceAction id="remote-desktop" label={t('remoteDesktop.title')} icon="computer" select={select} />
      <If when={!!props.autoRead}><WorkspaceAction id="auto-read" label={t('mobile.menu.autoRead')} icon="volume-up" selected={props.autoRead?.preferred} disabled={!props.autoRead?.available} select={() => { if (current()) { menu.set(false); props.autoRead?.onToggle(); } }} /></If>
      <WorkspaceAction id="refresh" label={t('sessions.sidebar.session.menu.refreshTranscript')} icon="refresh" select={select} />
    </ChatHeaderPopup>
  </View>;
}

function WorkspaceAction(props: { id: ChatHeaderOption; label: string; icon: Parameters<typeof Icon>[0]['name']; dirty?: boolean; selected?: boolean; disabled?: boolean; select: (option: ChatHeaderOption) => void }) {
  const content = () => <><View class="opacity-60"><If when={props.id === 'mcp'} else={<Icon name={props.icon} size={18} />}><HeaderMcpIcon /></If></View><Text class="text-sm text-foreground flex-1">{props.label}</Text><If when={props.selected}><Icon name="check" size={16} /></If><If when={props.dirty}><View class="rounded-full bg-ring" style={{ width: 7, height: 7 }} /></If></>;
  const rowClass = 'px-4 flex-row items-center gap-3 border-b border-border active:bg-accent disabled:opacity-40';
  return <If when={props.id === 'auto-read'} else={<Button testID={`chat-menu-${props.id}`} disabled={props.disabled} class={rowClass} style={{ height: 46 }} onPress={() => props.select(props.id)}>{content()}</Button>}>
    <Toggle testID={`chat-menu-${props.id}`} pressed={props.selected === true} disabled={props.disabled} accessibilityLabel={props.label} class={rowClass} style={{ height: 46 }} onChange={() => props.select(props.id)}>{content()}</Toggle>
  </If>;
}

/** Original artwork from shared components/icons/McpIcon.tsx, not a plug substitute. */
function HeaderMcpIcon() {
  const source = () => {
    const color = String(token('foreground'));
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="-0.5 -0.5 25 25" fill="${color}" stroke="${color}" stroke-width="0.5" fill-rule="evenodd"><path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z"/><path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z"/></svg>`);
  };
  return <Image src={source()} accessible={false} style={{ width: 18, height: 18 }} />;
}
