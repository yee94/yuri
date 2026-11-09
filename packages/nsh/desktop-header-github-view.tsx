import { computed, effect, Image, signal, Text, View } from 'nsh';
import { Button, Menu, MenuItem, MenuSeparator, Tooltip } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { desktopHeaderGitHubAvatar, type DesktopHeaderGitHubPort, type DesktopHeaderGitHubResult } from './desktop-header-github-core';

function Avatar(props: { src?: string; login?: string | null }) {
  const safe = computed(() => desktopHeaderGitHubAvatar(props.src) ?? '');
  return <Each of={[safe()]} key={value => value}>{src => {
    const failed = signal(false);
    return <View class="rounded-full bg-muted overflow-hidden items-center justify-center border border-border" style={{ width: 24, height: 24 }}>
      <If when={!!src() && !failed()} else={<Icon name="github-fill" size={14} />}><Image testID="desktop-header-github-avatar" src={src()} style={{ width: 24, height: 24 }} accessibilityLabel={props.login ? t('header.github.avatarWithLogin', { login: props.login }) : t('header.github.avatar')} onError={() => failed.set(true)} /></If>
    </View>;
  }}</Each>;
}

/** Header only. No loader effect, Settings navigation, OAuth action or disconnected placeholder. */
export function DesktopHeaderGitHub(props: { port: DesktopHeaderGitHubPort; onOpen?: () => void; onResult?: (result: DesktopHeaderGitHubResult) => void }) {
  const menu = signal(false), value = () => props.port.state().projection;
  effect(() => { if (!props.port.available()) menu.set(false); });
  const title = () => value()?.login ? t('header.github.connectedWithLogin', { login: value()!.login! }) : t('header.github.connected');
  async function select(key: string) {
    if (!props.port.available()) return;
    menu.set(false);
    const result = await props.port.select(key);
    if (props.port.interactive()) props.onResult?.(result);
  }
  function changeOpen(open: boolean) {
    if (!open) { menu.set(false); return; }
    if (menu() || !props.port.available()) return;
    props.onOpen?.();
    menu.set(props.port.available());
  }
  return <If when={props.port.visible() && !!value()}>
    <If when={(value()?.accounts.length ?? 0) > 1} else={<View testID="desktop-header-github-single" accessibilityLabel={title()} tooltip={<Tooltip placement="bottom"><View class="bg-popover rounded-md px-2 py-1"><Text class="text-xs text-foreground">{title()}</Text></View></Tooltip>}><Avatar src={value()?.avatarUrl} login={value()?.login} /></View>}>
      <Menu open={menu() && props.port.available()} align="end" popupClass="bg-popover rounded-xl border border-border p-1 shadow-lg" popupStyle={{ width: 256 }} onOpenChange={event => changeOpen(event.open)}
        trigger={<Button testID="desktop-header-github-menu" disabled={!props.port.available()} accessibilityLabel={title()} class="items-center justify-center rounded-full hover:bg-secondary disabled:opacity-50" style={{ width: 24, height: 24 }}
          tooltip={<Tooltip placement="bottom"><View class="bg-popover rounded-md px-2 py-1"><Text class="text-xs text-foreground">{title()}</Text></View></Tooltip>}><Avatar src={value()?.avatarUrl} login={value()?.login} /></Button>}>
        <Text class="px-2 py-1 text-foreground" style={{ fontSize: 13, fontWeight: '600' }}>{t('header.github.accountsTitle')}</Text><MenuSeparator class="h-px bg-border my-1" />
        <Each of={value()?.accounts ?? []}>{account => <MenuItem testID={`desktop-header-github-account-${account().source}-${account().id}`} checked={account().current} disabled={!props.port.available()}
          class="flex-row items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary disabled:opacity-50" onSelect={() => { if (!account().current) void select(account().key); }}>
          <Avatar src={account().avatarUrl} login={account().login} /><View class="flex-1 min-w-0"><Text class="text-foreground" style={{ fontSize: 13, numberOfLines: 1 }}>{account().label}</Text>
            <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{account().login} · {t(account().source === 'gh-cli' ? 'header.github.accountSource.cli' : 'header.github.accountSource.oauth')}</Text></View>
        </MenuItem>}</Each>
      </Menu>
    </If>
  </If>;
}
