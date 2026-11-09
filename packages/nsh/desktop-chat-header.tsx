import { cleanup, effect, Image, lifecycle, Scroll, signal, Text, token, untracked, View, windowSize, type JSX, type ViewRef } from 'nsh';
import { Button, Menu, MenuItem, MenuSeparator, Popover, Tooltip } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import type { ChatHeaderMetadata } from './chat-header-metadata';
import { createDesktopHeaderQuotaFamilies, DesktopChatHeaderQuota } from './desktop-chat-header-quota';
import { createDesktopChatHeaderActions, desktopChatHeaderLayout as layout, desktopHeaderContext, type DesktopChatHeaderAction, type DesktopChatHeaderActions, type DesktopChatHeaderResult } from './desktop-chat-header-core';
import { DesktopHeaderGitHub } from './desktop-header-github-view';
import type { DesktopHeaderGitHubPort } from './desktop-header-github-core';

type IconName = Parameters<typeof Icon>[0]['name'];
export type NativeDesktopChatHeaderActionsProps = {
  scope: unknown;
  current: () => boolean;
  active: boolean;
  operation?: () => { current(): boolean } | null;
  metadata?: ChatHeaderMetadata;
  sessionTitle: string;
  status?: { workStatusSelected: boolean; panelOpen: boolean; contextOpen: boolean; browserOpen: boolean };
  actions?: DesktopChatHeaderActions;
  host?: { label: string; icon?: IconName; showButton?: boolean };
  openInApps?: { applicable: boolean; selectedID?: string; apps: { id: string; label: string; icon?: string }[]; scanning?: boolean; stale?: boolean };
  githubPort?: DesktopHeaderGitHubPort;
  services?: { instance?: () => JSX.Element; mcp?: () => JSX.Element };
  onServicesTabChange?: (tab: ServicesTab | null) => void;
  servicesBusy?: boolean;
  workStatusRef?: (node: ViewRef) => void;
  onWorkStatusLayout?: () => void;
  shortcutLabels?: Partial<Record<'mini-chat' | 'terminal' | 'browser' | 'services' | 'usage', string>>;
  onResult: (action: DesktopChatHeaderAction, result: DesktopChatHeaderResult) => void;
};

const iconClass = 'items-center justify-center rounded-md hover:bg-secondary active:bg-accent focus:border focus:border-ring disabled:opacity-50';
const popupClass = 'bg-popover rounded-xl border border-border p-1 shadow-lg';
type ServicesTab = 'instance' | 'usage' | 'mcp';

/** Root owns data/lifecycle. Only a real scope replacement remounts presentation;
 * draft, status, metadata, modal and foreground changes never replace its owner. */
export function NativeDesktopChatHeaderActions(props: NativeDesktopChatHeaderActionsProps) {
  return <Each of={[props.scope]} key={scope => scope}>{() => <DesktopHeaderActions {...props} />}</Each>;
}

function DesktopHeaderActions(props: NativeDesktopChatHeaderActionsProps) {
  const menu = signal(false), services = signal<ServicesTab | null>(null), apps = signal(false);
  const pending = signal(false), contextDetails = signal(false);
  const quotaFamilies = createDesktopHeaderQuotaFamilies();
  const current = () => props.current() && props.active && lifecycle() === 'active' && (!props.operation || props.operation()?.current() === true);
  const owner = createDesktopChatHeaderActions({ scope: () => props.scope, current, operation: props.operation ? () => props.operation?.() : undefined, actions: () => props.actions, changed: value => pending.set(value) });
  const enabled = () => owner.current() && !pending() && !(services() !== null && props.servicesBusy);
  const available = (action: DesktopChatHeaderAction) => !pending() && owner.available(action);
  function setServices(tab: ServicesTab | null) {
    if (services() === tab) return;
    services.set(tab); props.onServicesTabChange?.(tab);
  }
  function close() { menu.set(false); setServices(null); apps.set(false); contextDetails.set(false); }
  cleanup(() => { props.onServicesTabChange?.(null); owner.dispose(); });
  let assignedOperation = untracked(() => props.operation?.());
  effect(() => {
    const next = props.operation?.();
    if (next !== assignedOperation || !current()) untracked(() => { assignedOperation = next; close(); owner.invalidate(); });
  });
  async function act(action: DesktopChatHeaderAction, value?: string) {
    const result = await owner.run(action, value);
    if (owner.current() && result.status !== 'stale') props.onResult(action, result);
  }
  function showServices(tab: ServicesTab) {
    if (!enabled()) return;
    menu.set(false); apps.set(false); contextDetails.set(false); setServices(tab);
    if (tab === 'usage' && !props.metadata?.quota?.loaded && !props.metadata?.quota?.loading && available('refresh-usage')) void act('refresh-usage');
  }
  const hostLabel = () => props.host?.label || t('common.unavailable');
  const context = () => desktopHeaderContext(props.metadata);
  const contextLabel = () => {
    const value = context();
    if (!value) return t('common.unavailable');
    if (value.pending) return t('contextUsage.pending');
    return `${value.percentage!.toFixed(1)}%  ${formatTokens(value.tokens!)}/${formatTokens(value.limit!)}`;
  };
  const selectedApp = () => props.openInApps?.apps.find(app => app.id === props.openInApps?.selectedID);
  const hasApps = () => props.openInApps?.applicable !== false;
  const splitWidth = { width: layout.splitButton, height: layout.iconButton };
  function trigger(id: string, label: string, icon: IconName, press?: () => void, selected = false, disabled = !enabled(), size: number = layout.iconButton) {
    return <Button testID={`desktop-chat-header-${id}`} accessibilityLabel={label} selected={selected} disabled={disabled}
      ref={id === 'work-status' ? props.workStatusRef : undefined} onLayout={id === 'work-status' ? props.onWorkStatusLayout : undefined}
      tooltip={<Tooltip placement="bottom"><View class="bg-popover rounded-md px-2 py-1"><Text class="text-xs text-foreground">{label}{disabled ? ` · ${t('common.unavailable')}` : ''}</Text></View></Tooltip>}
      class={iconClass + (selected ? ' bg-accent' : '')} style={{ width: size, height: size }} onPress={press}>
      <Icon name={icon} size={size === layout.menuButton ? 18 : layout.icon} color={String(token('muted-foreground'))} />
    </Button>;
  }
  function item(action: DesktopChatHeaderAction, label: string, icon: IconName, shortcut?: string, checked?: boolean) {
    return <MenuItem testID={`desktop-chat-header-menu-${action}`} disabled={!available(action)} checked={checked} accessibilityLabel={label}
      class="flex-row items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary focus:bg-secondary disabled:opacity-50"
      style={{ minHeight: 30 }} onSelect={() => { menu.set(false); void act(action); }}>
      <Icon name={icon} size={14} color={String(token('muted-foreground'))} />
      <Text class="flex-1 text-foreground" style={{ fontSize: 13, lineHeight: 20 }}>{label}</Text>
      <If when={!available(action)} else={<Text class="text-xs text-muted-foreground">{shortcut || (checked ? '✓' : '')}</Text>}><Text class="text-xs text-muted-foreground">{t('common.unavailable')}</Text></If>
    </MenuItem>;
  }
  function serviceItem(tab: 'instance' | 'usage', label: string, icon: IconName) {
    return <MenuItem testID={`desktop-chat-header-menu-${tab}`} disabled={!enabled()} class="flex-row items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary focus:bg-secondary" style={{ minHeight: 30 }} onSelect={() => showServices(tab)}>
      <Icon name={icon} size={14} color={String(token('muted-foreground'))} /><Text class="text-foreground flex-1" style={{ fontSize: 13, lineHeight: 20 }}>{label}</Text>
      <Text class="text-xs text-muted-foreground">{props.shortcutLabels?.[tab === 'instance' ? 'services' : 'usage'] || ''}</Text>
    </MenuItem>;
  }
  return <View testID="desktop-chat-header-actions" role="group" accessibilityLabel={props.sessionTitle} class="flex-row items-center shrink-0" style={{ height: layout.height, gap: layout.gap }}>
    <Popover open={owner.current() && services() !== null} placement="bottom" align="start" offset={layout.popupOffset} margin={layout.popupMargin}
      closeOnEscape={!props.servicesBusy} closeOnPressOutside={!props.servicesBusy}
      popupClass={popupClass} popupStyle={{ width: Math.min(layout.servicesWidth, windowSize().width - 24), maxHeight: windowSize().height * .75 }}
      onOpenChange={event => { if (!event.open && !props.servicesBusy) setServices(null); }}
      trigger={<Menu open={owner.current() && menu()} align="start" offset={layout.popupOffset} margin={layout.popupMargin} popupClass={popupClass} popupStyle={{ minWidth: layout.menuWidth }}
        onOpenChange={event => { if (!event.open) menu.set(false); else if (enabled()) { close(); menu.set(true); } }}
        trigger={trigger('menu', t('header.actions.sessionMenuAria'), 'more-2', undefined, false, !enabled(), layout.menuButton)}>
        {item('mini-chat', t('header.actions.openSessionMiniChat'), 'picture-in-picture-2', props.shortcutLabels?.['mini-chat'])}
        {serviceItem('instance', t('header.actions.sessionMenu.servicesWithInstance', { current: hostLabel() }), 'stack')}
        {serviceItem('usage', t('header.actions.sessionMenu.viewUsage'), 'timer')}
        <MenuSeparator class="h-px bg-border my-1" />
        {item('terminal', t('header.actions.toggleTerminalPanel'), 'terminal-box', props.shortcutLabels?.terminal)}
        {item('browser', t('contextPanel.browser.open'), 'global', props.shortcutLabels?.browser, props.status?.browserOpen)}
      </Menu>}>
      <View testID="desktop-chat-header-services" class="min-h-0">
        <View class="flex-row items-center gap-1 px-1 py-1" role="tablist" accessibilityLabel={t('header.services.title')}>
          <Each of={['instance', 'usage', 'mcp'] as const}>{tab => <Button testID={`desktop-chat-header-tab-${tab()}`} role="tab" selected={services() === tab()} disabled={!enabled()}
            class={`flex-1 items-center justify-center rounded-md ${services() === tab() ? 'bg-accent' : 'hover:bg-secondary'}`} style={{ height: 32 }} onPress={() => showServices(tab())}>
            <Text class="text-foreground" style={{ fontSize: 13 }}>{tab() === 'mcp' ? 'MCP' : t(tab() === 'instance' ? 'layout.services.instance' : 'layout.services.usage')}</Text>
          </Button>}</Each>
        </View>
        <Scroll testID="desktop-chat-header-services-scroll" style={{ maxHeight: Math.max(80, windowSize().height * .75 - 48) }}>
          <If when={services() === 'instance'}><View testID="desktop-chat-header-instance">{props.services?.instance?.() ?? <View class="p-3"><Unavailable /></View>}</View></If>
          <If when={services() === 'mcp'}><View testID="desktop-chat-header-mcp">{props.services?.mcp?.() ?? <View class="p-3"><Unavailable /></View>}</View></If>
          <If when={services() === 'usage'}>
            <DesktopChatHeaderQuota snapshot={props.metadata?.quota} refreshAvailable={available('refresh-usage')} modeAvailable={available('quota-mode')}
              familyState={quotaFamilies} interactive={enabled()} current={owner.current}
              refresh={() => { void act('refresh-usage'); }} mode={value => { void act('quota-mode', value); }} />
          </If>
        </Scroll>
      </View>
    </Popover>
    <If when={context() !== null}>
      <View class="flex-row items-center" onMouseEnter={() => contextDetails.set(true)} onMouseLeave={() => contextDetails.set(false)}>
        <Button testID="desktop-chat-header-context" selected={props.status?.contextOpen} disabled={!available('context')} accessibilityLabel={`${t('contextUsage.aria.label')}: ${contextLabel()}`}
          class={iconClass + (props.status?.contextOpen ? ' bg-accent' : '')} style={{ height: 28, paddingLeft: 6, paddingRight: 6 }}
          tooltip={<Tooltip placement="bottom"><View class="bg-popover rounded-md px-2 py-1"><Text class="text-xs text-foreground">{contextLabel()}</Text></View></Tooltip>}
          onPress={() => { void act('context'); }}>
          <View class="flex-row items-center"><DesktopContextRing progress={context()?.progress ?? 0} />
            <If when={contextDetails() || props.status?.contextOpen || context()?.pending}><Text testID="desktop-chat-header-context-detail" class="text-foreground ml-1" style={{ fontSize: 11, lineHeight: 17 }}>{contextLabel()}</Text></If>
          </View>
        </Button>
      </View>
    </If>
    {trigger('work-status', t('header.workStatusPanel.toggleAria'), 'settings-2', () => { void act('work-status'); }, props.status?.workStatusSelected, !available('work-status'))}
    <If when={hasApps()}>
      <View testID="desktop-chat-header-open-app-split" class="flex-row items-center rounded-md border border-border" style={splitWidth}>
        <Button testID="desktop-chat-header-open-app" class={iconClass} style={{ width: 28, height: 26 }} disabled={!available(selectedApp() ? 'open-app' : 'copy-path') || props.openInApps?.scanning}
          accessibilityLabel={selectedApp() ? t('openInApp.actions.openInAria', { app: selectedApp()!.label }) : t('openInApp.actions.copyPath')}
          onPress={() => { void act(selectedApp() ? 'open-app' : 'copy-path', selectedApp()?.id); }}>
          <If when={!!selectedApp()?.icon} else={<If when={!!selectedApp()} else={<Icon name="file-copy" size={16} />}><Text class="text-foreground" style={{ fontSize: 10 }}>{selectedApp()?.label.trim().slice(0, 1).toLocaleUpperCase() || '?'}</Text></If>}><Image src={selectedApp()!.icon!} accessible={false} style={{ width: 16, height: 16 }} /></If>
        </Button>
        <Menu open={enabled() && apps()} align="end" offset={6} margin={12} popupClass={popupClass} popupStyle={{ minWidth: 224 }}
          onOpenChange={event => { if (!event.open) apps.set(false); else if (enabled()) { close(); apps.set(true); } }}
          trigger={<Button testID="desktop-chat-header-apps" accessibilityLabel={t('openInApp.actions.chooseAppAria')} disabled={!enabled()} class={iconClass} style={{ width: 16, height: 26 }}><Icon name="arrow-down-s" size={10} /></Button>}>
          {item('copy-path', t('openInApp.actions.copyPath'), 'file-copy')}
          <MenuSeparator class="h-px bg-border my-1" />
          <If when={props.openInApps !== undefined} else={<View class="p-2"><Unavailable /></View>}>
            <Each of={props.openInApps?.apps ?? []}>{app => <MenuItem testID={`desktop-chat-header-app-${app().id}`} disabled={!available('select-app')} checked={props.openInApps?.selectedID === app().id}
              class="flex-row items-center gap-2 px-2 py-1.5 hover:bg-secondary focus:bg-secondary disabled:opacity-50" onSelect={() => { apps.set(false); void act('select-app', app().id); }}>
              <Text class="text-foreground flex-1" style={{ fontSize: 13 }}>{app().label}</Text><If when={props.openInApps?.selectedID === app().id}><Icon name="check" size={14} /></If>
            </MenuItem>}</Each>
          </If>
          <If when={props.openInApps?.stale}>{item('scan-apps', t('openInApp.actions.refreshApps'), 'refresh')}</If>
        </Menu>
      </View>
    </If>
    <If when={props.host?.showButton !== false}>
      <Button testID="desktop-chat-header-host" class="flex-row items-center justify-center rounded-md border border-border hover:bg-secondary disabled:opacity-50" style={splitWidth} disabled={!enabled()}
        selected={services() === 'instance'} accessibilityLabel={t('header.actions.sessionMenu.servicesWithInstance', { current: hostLabel() })}
        tooltip={<Tooltip placement="bottom"><View class="bg-popover rounded-md px-2 py-1"><Text class="text-xs text-foreground">{hostLabel()}</Text></View></Tooltip>}
        onPress={() => showServices('instance')}><Icon name={props.host?.icon ?? 'stack'} size={20} /><Icon name="arrow-down-s" size={10} /></Button>
    </If>
    {trigger('panel', t('contextPanel.actions.togglePanel'), 'folder-3', () => { void act('toggle-panel'); }, props.status?.panelOpen, !available('toggle-panel'))}
    <If when={!!props.githubPort}><DesktopHeaderGitHub port={props.githubPort!} onOpen={close}
      onResult={result => { if (current() && !['accepted', 'noop', 'stale'].includes(result.status)) props.onResult('github-account', { status: result.status === 'unknown' ? 'unknown' : 'failed' }); }} /></If>
  </View>;
}

function Unavailable() { return <Text class="text-sm text-muted-foreground">{t('common.unavailable')}</Text>; }
function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(1).replace(/\.0$/, '');
}
function DesktopContextRing(props: { progress: number }) {
  const source = () => {
    const circumference = 2 * Math.PI * 8, offset = circumference * (1 - props.progress);
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><g transform="rotate(-90 9 9)"><circle cx="9" cy="9" r="8" fill="none" stroke="${token('border')}" stroke-width="2"/><circle cx="9" cy="9" r="8" fill="none" stroke="${token('muted-foreground')}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/></g></svg>`);
  };
  return <Image testID="desktop-chat-header-context-ring" src={source()} accessible={false} style={{ width: 16, height: 16 }} />;
}
