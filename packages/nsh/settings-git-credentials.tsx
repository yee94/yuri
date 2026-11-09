import { cleanup, effect, lifecycle, signal, Text, untracked, View, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { SettingsChoice, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { SettingsTarget } from './settings-target';
import { gitSettingsNativeRequest } from './settings-github';
import { createSettingsGitCredentials, unimportedGitCredentials, type GitCredentialsDependencies, type GitCredentialsState } from './settings-git-credentials-core';
import { publishSettingsEditor } from './desktop-settings-publisher';
const credentialColors = ['keyword', 'error', 'string', 'function', 'type'] as const;
const credentialIcons = ['branch', 'briefcase', 'house', 'graduation', 'code'] as const;

export const settingsGitCredentialsSearchTarget = 'git.discovered-credentials';
export const settingsGitCredentialsSearchItem = { page: 'git', id: settingsGitCredentialsSearchTarget, title: 'settings.gitIdentities.page.discoveredCredentials.title', keywords: 'git credentials token import discovered 凭据 导入' } as const;
/** Discovered metadata is never a token input. Editing a profile does not read/copy the source credential. */
export function SettingsGitCredentials(props: { active: boolean; target?: string; onReveal?: (node: ViewRef) => void; onSaved?: () => void; dependencies?: GitCredentialsDependencies; id?: () => string }) {
  const lifetime = settingsPageLifetime(() => props.active === true && lifecycle() === 'active');
  const createID = props.id ?? (() => `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  let authority: object | null = null;
  const dependencies = (op: SettingsOperation | null): GitCredentialsDependencies => {
    const token = {}; authority = token;
    const current = () => authority === token && op?.current() === true;
    return { current, request: gitSettingsNativeRequest(current, op?.scope ?? null), id: createID };
  };
  const deps: GitCredentialsDependencies = props.dependencies ?? dependencies(lifetime.operation());
  const controller = createSettingsGitCredentials({ ...deps, changed: next => { state.set(next); deps.changed?.(next); }, onSaved: () => { deps.onSaved?.(); props.onSaved?.(); } });
  const state = signal<GitCredentialsState>(controller.state());
  const candidates = () => {
    const { credentials, profiles } = state();
    return credentials.value && profiles.value ? unimportedGitCredentials(credentials.value, profiles.value) : [];
  };
  const current = () => props.dependencies ? deps.current() : lifetime.current();
  const active = () => props.active === true && lifecycle() === 'active' && current();
  const disabled = () => !active() || state().busy || state().refreshing || !!state().pending;
  const initialDraft = signal<GitCredentialsState['draft']>(null);
  const editorNavigation = publishSettingsEditor({ current, scope: lifetime.operation,
    pending: () => state().busy || state().refreshing || !!state().pending, dirty: () => !!state().draft && JSON.stringify(state().draft) !== JSON.stringify(initialDraft()), stamp: () => [state().draft],
  });
  async function cancelEditor() { if (await editorNavigation.requestLeave()) controller.cancel(); }
  let assigned = lifetime.operation();
  effect(() => {
    const visible = active(), op = visible ? lifetime.operation() : null;
    untracked(() => {
      if (!props.dependencies && assigned !== op) {
        assigned = op; controller.replaceLane({ ...dependencies(op), changed: next => state.set(next), onSaved: () => props.onSaved?.() });
      }
      void controller.setActive(visible);
    });
  });
  cleanup(() => controller.dispose());
  const error = () => t(state().issue === 'unknown' ? 'settings.github.native.unknown' : state().issue === 'duplicate' ? 'settings.github.native.duplicate' : state().issue === 'source' ? 'settings.github.native.identity' : state().issue === 'required' ? 'settings.gitIdentities.editor.toast.userNameEmailRequired' : state().issue === 'host' ? 'settings.gitIdentities.editor.toast.hostRequiredForToken' : state().issue === 'signing' ? 'settings.gitIdentities.editor.toast.signingKeyRequired' : 'settings.nsh.about.versionFailed');
  return <SettingsTarget id={settingsGitCredentialsSearchTarget} target={props.target} onReveal={props.onReveal}><SettingsGroup title={t('settings.gitIdentities.page.discoveredCredentials.title')}>
      <If when={!!state().issue}><Text testID="git-credentials-error" class="text-sm text-destructive">{error()}</Text></If>
      <If when={state().saved}><Text testID="git-credentials-saved" class="text-sm text-muted-foreground">{t('settings.gitIdentities.editor.toast.profileCreated')}</Text></If>
      <Button testID="git-credentials-refresh" class={settingsAction} disabled={!active() || state().busy || state().refreshing} onPress={() => { void controller.refresh(); }}><Text class="text-foreground">{t('settings.usage.sidebar.actions.refreshTitle')}</Text></Button>
       <Each of={candidates()}>{credential => <View class="gap-2"><Text class="text-sm text-foreground">{credential().host}</Text><Text class="text-xs text-muted-foreground">{credential().username}</Text><Button testID={`git-credential-import-${credential().host}-${credential().username}`} class={settingsAction} disabled={disabled() || state().credentials.failed || state().profiles.failed || !!state().draft} onPress={() => { controller.begin(credential()); initialDraft.set(state().draft); }}><Text class="text-foreground">{t('settings.gitIdentities.page.actions.import')}</Text></Button></View>}</Each>
      <If when={!!state().draft}><View testID="git-credential-editor" class="gap-3">
        <Text class="text-sm text-foreground">{t('settings.gitIdentities.editor.title.importCredential')}</Text>
        <SettingsInput testID="git-credential-name" title={t('settings.gitIdentities.editor.field.profileName')} value={state().draft?.name || ''} disabled={disabled()} onChange={value => controller.edit('name', value)} />
        <SettingsChoice title={t('settings.gitIdentities.editor.field.color')} value={state().draft?.color || 'string'} disabled={disabled()} items={credentialColors.map(value => ({ value, title: t(`settings.github.native.color.${value}`) }))} onChange={value => controller.edit('color', value)} />
        <SettingsChoice title={t('settings.gitIdentities.editor.field.icon')} value={state().draft?.icon || 'code'} disabled={disabled()} items={credentialIcons.map(value => ({ value, title: t(`settings.github.native.icon.${value}`) }))} onChange={value => controller.edit('icon', value)} />
        <SettingsInput testID="git-credential-user" title={t('settings.gitIdentities.editor.field.userName')} value={state().draft?.userName || ''} disabled={disabled()} onChange={value => controller.edit('userName', value)} />
        <SettingsInput testID="git-credential-email" title={t('settings.gitIdentities.editor.field.emailAddress')} value={state().draft?.userEmail || ''} disabled={disabled()} onChange={value => controller.edit('userEmail', value)} />
        <SettingsChoice title={t('settings.gitIdentities.editor.field.authMethod')} value={state().draft?.authType || 'token'} disabled={disabled()} items={[{ value: 'ssh', title: 'SSH' }, { value: 'token', title: t('settings.gitIdentities.editor.field.authToken') }]} onChange={value => controller.edit('authType', value)} />
        <If when={state().draft?.authType === 'token'}><SettingsInput title={t('settings.gitIdentities.editor.field.host')} value={state().draft?.host || ''} disabled={disabled()} onChange={value => controller.edit('host', value)} /></If>
        <If when={state().draft?.authType === 'ssh'}><SettingsInput title={t('settings.gitIdentities.editor.field.sshKeyPath')} value={state().draft?.sshKey || ''} disabled={disabled()} onChange={value => controller.edit('sshKey', value)} /></If>
        <SettingsToggle title={t('settings.gitIdentities.editor.field.signCommits')} value={state().draft?.signCommits === true} disabled={disabled()} onChange={value => controller.setSignCommits(value)} />
        <If when={state().draft?.signCommits}><SettingsInput title={t('settings.gitIdentities.editor.field.signingKey')} value={state().draft?.signingKey || ''} disabled={disabled()} onChange={value => controller.edit('signingKey', value)} /></If>
        <Button testID="git-credential-save" class={settingsAction} disabled={disabled()} onPress={() => { void controller.save(); }}><Text class="text-foreground">{t('settings.gitIdentities.editor.actions.create')}</Text></Button>
        <Button testID="git-credential-cancel" class={settingsAction} disabled={disabled()} onPress={() => { void cancelEditor(); }}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button>
      </View></If>
      <If when={!!state().pending && state().inspected}><Button testID="git-credential-accept-state" class={settingsAction} disabled={!active() || state().busy || state().refreshing} onPress={() => controller.acknowledgeUnknown()}><Text class="text-foreground">{t('settings.github.native.accept')}</Text></Button></If>
  </SettingsGroup></SettingsTarget>;
}
