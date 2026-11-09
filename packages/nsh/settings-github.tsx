import { cleanup, effect, Image, lifecycle, openUrl, signal, Text, untracked, View, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { bindRawRequest } from './runtime';
import { Icon } from './Icon';
import { SettingsGroup, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { app } from './state';
import { SettingsTarget } from './settings-target';
import { createSettingsGitHub, type GitHubDependencies, type GitHubState } from './settings-github-core';
import { gitSettingsResponse, type GitSettingsRequest } from './settings-github-protocol';
import { publishSettingsEditor } from './desktop-settings-publisher';

export const settingsGitHubSearchTarget = 'git.github-account';
export const settingsGitHubSearchItem = { page: 'git', id: settingsGitHubSearchTarget, title: 'settings.github.page.oauth.title', keywords: 'GitHub OAuth device account CLI 账户 授权' } as const;
export function gitSettingsNativeRequest(current: () => boolean, scope = app.runtimeScope()): GitSettingsRequest {
  const send = bindRawRequest(scope);
  return async (path, method = 'GET', body) => {
    if (!current()) throw new Error('Inactive Git settings scope');
    const result = await send(path, method, body);
    if (!current()) throw new Error('Inactive Git settings scope');
    return gitSettingsResponse(result);
  };
}

/** Fragment owned by the Git page's Scroll/NavPage. Route owner passes actual top-route active. */
export function SettingsGitHub(props: { active: boolean; target?: string; onReveal?: (node: ViewRef) => void; dependencies?: GitHubDependencies; open?: GitHubDependencies['open'] }) {
  const lifetime = settingsPageLifetime(() => props.active === true && lifecycle() === 'active');
  const open = props.open ?? (async (url: string) => (await openUrl(url)).opened);
  // Each assigned lane owns one raw sender; replacement never redirects lease cleanup.
  let authority: object | null = null;
  const dependencies = (op: SettingsOperation | null): GitHubDependencies => {
    const token = {}; authority = token;
    const current = () => authority === token && op?.current() === true;
    return { current, request: gitSettingsNativeRequest(current, op?.scope ?? null),
      open: async url => { if (!current()) return false; const opened = await open(url); return current() && opened; },
    };
  };
  const deps: GitHubDependencies = props.dependencies ?? dependencies(lifetime.operation());
  let update: ((next: GitHubState) => void) | undefined;
  const controller = createSettingsGitHub({ ...deps, changed: next => { update?.(next); deps.changed?.(next); } });
  const state = signal<GitHubState>(controller.state());
  update = next => state.set(next);
  const current = () => props.dependencies ? deps.current() : lifetime.current();
  const active = () => props.active === true && lifecycle() === 'active' && current();
  const disabled = () => !active() || state().busy || state().refreshing || state().exchanging || state().needsReadback || !!state().pending || !!state().flow || !state().status || !!deps.sharedStatus && state().stale;
  publishSettingsEditor({ current, scope: lifetime.operation, dirty: () => false, stamp: () => [],
    pending: () => state().busy || state().refreshing || state().exchanging || state().needsReadback || !!state().pending || !!state().flow || !!state().removal || state().cancellation === 'stopping',
  });
  const currentAccount = () => state().status?.accounts.find(account => account.current);
  let assigned = lifetime.operation();
  effect(() => {
    const visible = active(), op = visible ? lifetime.operation() : null;
    untracked(() => {
      if (!props.dependencies && assigned !== op) {
        assigned = op; controller.replaceLane({ ...dependencies(op), changed: next => state.set(next) });
      }
      void controller.setActive(visible);
    });
  });
  cleanup(() => controller.dispose());
  const issueText = () => {
    const issue = state().issue;
    if (issue === 'unknown' || issue === 'expired' || issue === 'denied' || issue === 'identity' || issue === 'unsupported') return t(`settings.github.native.${issue}`);
    return t(issue === 'read' ? 'settings.nsh.about.versionFailed' : issue === 'open' ? 'settings.providers.page.toast.oauthStartFailed' : 'settings.github.page.toast.startConnectFailed');
  };
  return <SettingsTarget id={settingsGitHubSearchTarget} target={props.target} onReveal={props.onReveal}><SettingsGroup title={t('settings.github.page.oauth.title')}>
      <If when={!!state().issue}><Text testID="github-error" class="text-sm text-destructive">{issueText()}</Text></If>
      <If when={!!deps.sharedStatus && state().stale && !!state().status}><Text testID="github-stale" class="text-xs text-muted-foreground">{t('assistants.state.staleSnapshot')}</Text></If>
      <If when={!!state().cancellation}><Text testID="github-cancellation" class="text-sm text-muted-foreground">{t(state().cancellation === 'stopping' ? 'settings.github.native.cancelling' : state().cancellation === 'unknown' ? 'settings.github.native.cancelUnknown' : state().cancellation === 'unsupported' ? 'settings.github.native.unsupported' : 'settings.github.native.cancelled')}</Text></If>
      <Button testID="github-refresh" class={settingsAction} disabled={!active() || state().refreshing || state().busy} onPress={() => { void controller.refresh(); }}><Text class="text-foreground">{t('settings.usage.sidebar.actions.refreshTitle')}</Text></Button>
      <If when={!!state().status}>
        <View class="flex-row items-center gap-3"><If when={!!state().status?.user?.avatarUrl}><Image src={state().status?.user?.avatarUrl || ''} style={{ width: 40, height: 40, borderRadius: 20 }} accessibilityLabel={t('settings.github.page.avatarAlt.withLogin', { login: state().status?.user?.login || '' })} /></If><If when={!state().status?.user?.avatarUrl}><Icon name="github-fill" size={24} /></If><Text testID="github-current" class="text-sm text-foreground">{state().status?.connected ? state().status?.user?.name || state().status?.user?.login || t('settings.github.page.label.unknownUser') : t('settings.github.page.status.notConnected')}</Text></View>
        <If when={state().status?.connected}><Text class="text-xs text-muted-foreground">{state().status?.user?.login} · {t(state().status?.ghCli?.active ? 'settings.github.page.accountSource.cli' : 'settings.github.page.accountSource.oauth')}</Text><If when={!!state().status?.user?.email}><Text class="text-xs text-muted-foreground">{state().status?.user?.email}</Text></If><If when={!!state().status?.scope}><Text class="text-xs text-muted-foreground">{t('settings.github.page.label.scopes', { value: state().status?.scope || '' })}</Text></If></If>
        <If when={state().status?.accounts.some(account => !account.current)}><Text class="text-xs text-muted-foreground">{t('settings.github.page.label.otherAccounts')}</Text></If>
        <Each of={state().status?.accounts.filter(account => !account.current) ?? []}>{account => <View class="gap-2">
          <View class="flex-row items-center gap-3"><If when={!!account().user.avatarUrl}><Image src={account().user.avatarUrl || ''} style={{ width: 24, height: 24, borderRadius: 12 }} accessibilityLabel={t('settings.github.page.avatarAlt.withLogin', { login: account().user.login })} /></If><If when={!account().user.avatarUrl}><Icon name="github-fill" size={16} /></If><Text class="text-sm text-foreground">{account().user.name || account().user.login}</Text></View><Text class="text-xs text-muted-foreground">{account().user.login} · {t(account().source === 'gh-cli' ? 'settings.github.page.accountSource.cli' : 'settings.github.page.accountSource.oauth')}</Text>
          <Button testID={`github-activate-${account().source}-${account().id}`} class={settingsAction} disabled={disabled()} onPress={() => { void controller.activate(account()); }}><Text class="text-foreground">{t('settings.github.page.actions.switchTo')}</Text></Button>
          <If when={account().source === 'oauth'}><Button testID={`github-remove-${account().source}-${account().id}`} class={settingsAction} disabled={disabled()} onPress={() => controller.requestRemoval(account())}><Text class="text-destructive">{t('settings.common.actions.delete')}</Text></Button></If>
        </View>}</Each>
        <Button testID="github-connect" class={settingsAction} disabled={disabled()} onPress={() => { void controller.connect(); }}><Text class="text-foreground">{t(state().status?.connected ? 'settings.github.page.actions.addAccount' : 'settings.github.page.actions.connect')}</Text></Button>
        <If when={state().status?.connected && !!currentAccount() && currentAccount()?.source === 'oauth'}><Button testID="github-remove" class={settingsAction} disabled={disabled()} onPress={() => { const account = currentAccount(); if (account) controller.requestRemoval(account); }}><Text class="text-destructive">{t('settings.github.page.actions.disconnect')}</Text></Button></If>
        <Text class="text-xs text-muted-foreground">{t('settings.github.native.removeHint')}</Text>
        <If when={state().status?.ghCli?.available}>
          <Text class="text-xs text-muted-foreground">{t(state().status?.ghCli?.disabled ? 'settings.github.page.ghCli.disabledDescription' : state().status?.ghCli?.active ? 'settings.github.page.ghCli.activeDescription' : 'settings.github.page.ghCli.fallbackDescription')}</Text>
          <Button testID="github-cli-toggle" class={settingsAction} disabled={disabled()} onPress={() => { void controller.setCliDisabled(!state().status?.ghCli?.disabled); }}><Text class="text-foreground">{t(state().status?.ghCli?.disabled ? 'settings.github.page.ghCli.actions.enable' : 'settings.github.page.ghCli.actions.disable')}</Text></Button>
        </If>
      </If>
      <If when={!!state().flow}><View testID="github-flow" class="gap-3">
        <If when={!state().flow?.cancellable}><Text class="text-xs text-muted-foreground">{t('settings.github.native.unsupported')}</Text></If>
        <Text class="text-sm text-foreground">{t('settings.github.page.flow.title')}</Text><Text class="text-xs text-muted-foreground">{t('settings.github.page.flow.description')}</Text><Text testID="github-user-code" class="font-mono text-xl text-foreground">{state().flow?.userCode}</Text>
        <Button testID="github-open" class={settingsAction} disabled={!active()} onPress={() => { void controller.open(); }}><Text class="text-foreground">{t('settings.github.page.actions.openGithub')}</Text></Button>
        <Text class="text-xs text-muted-foreground">{t('settings.github.page.flow.waiting')}</Text>
        <Button testID="github-cancel" class={settingsAction} disabled={!active()} onPress={() => { void controller.cancel(); }}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button>
      </View></If>
      <If when={!!state().removal}><View testID="github-delete-confirmation" class="gap-3">
        <Text class="text-sm text-foreground">{t('settings.github.page.actions.disconnect')} · {state().removal?.user.login} · {t('settings.github.page.accountSource.oauth')}</Text>
        <Text class="text-xs text-muted-foreground">{t('settings.github.native.removeHint')}</Text>
        <Button testID="github-delete-confirm" class={settingsAction} disabled={!active() || state().busy} onPress={() => { void controller.confirmRemoval(); }}><Text class="text-destructive">{t('settings.common.actions.delete')}</Text></Button>
        <Button testID="github-delete-cancel" class={settingsAction} disabled={state().busy} onPress={() => controller.cancelRemoval()}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button>
      </View></If>
      <If when={!!state().pending && state().reconciled}><Button testID="github-accept-state" class={settingsAction} disabled={!active() || state().busy || state().refreshing || state().exchanging} onPress={() => controller.acknowledgeUnknown()}><Text class="text-foreground">{t('settings.github.native.accept')}</Text></Button></If>
  </SettingsGroup></SettingsTarget>;
}
