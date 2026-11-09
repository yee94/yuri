import { Scroll, signal, Text, View, type ScrollRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { text, type Row } from './model';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { settingsObject, settingsRows } from './settings-protocol';
import { SettingsGitHub } from './settings-github';
import { SettingsGitCredentials } from './settings-git-credentials';
import { createSettingsTargetNavigation } from './settings-search-core';
import { DesktopSettingsPublisher, publishSettingsEditor } from './desktop-settings-publisher';
import type { DesktopSettingsGitHubSlot } from './desktop-header-github-root';

const gitFields: { key: string; title: I18nKey }[] = [
  { key: 'name', title: 'settings.gitIdentities.editor.field.profileName' },
  { key: 'userName', title: 'settings.gitIdentities.editor.field.userName' },
  { key: 'userEmail', title: 'settings.gitIdentities.editor.field.emailAddress' },
  { key: 'host', title: 'settings.gitIdentities.editor.field.host' },
  { key: 'sshKey', title: 'settings.gitIdentities.editor.field.sshKeyPath' },
  { key: 'signingKey', title: 'settings.gitIdentities.editor.field.signingKey' },
];
export function SettingsGit(props: SettingsCallbacks & SettingsRoute & { active?: boolean; desktopGitHub?: DesktopSettingsGitHubSlot }) {
  const state = settingsPageLifetime(), profiles = signal<Row[]>([]), global = signal<Row>({}), draft = signal<Row>({ name: '', userName: '', userEmail: '', authType: 'ssh', signCommits: false });

  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, state.current, () => state.operation()?.current ?? (() => false));
  const defaultID = signal(''), preferences = signal<Row>({});
  const editing = !!props.entity || !!props.create;
  function GitHubFragment() {
    const active = () => props.active === true && state.current();
    if (props.desktopGitHub) return props.desktopGitHub({ current: state.current, active,
      directory: () => props.directory ?? '', operation: state.operation, target: props.target,
      onReveal: node => { void navigation.reveal(node); },
    });
    if (DesktopSettingsPublisher()) return <View testID="desktop-settings-github-unavailable"><Text class="text-muted-foreground">{t('settings.view.unavailable.description')}</Text></View>;
    return <SettingsGitHub active={props.active === true} target={props.target} onReveal={node => { void navigation.reveal(node); }} />;
  }
  const initialDraft = signal(draft()), initialPreferences = signal<Row>({});
  publishSettingsEditor({ current: state.current, scope: state.operation, pending: state.busy,
    dirty: () => JSON.stringify(editing ? draft() : preferences()) !== JSON.stringify(editing ? initialDraft() : initialPreferences()),
    stamp: () => [draft(), preferences()],
  });
  const update = (key: string, value: unknown) => draft.set({ ...draft(), [key]: value });
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      const values = await Promise.all([operation.request('/api/git/identities'), operation.request('/api/git/global-identity'), operation.request('/api/config/settings')]);
      if (!operation.current()) return;
      const rows = settingsRows(values[0]), settings = settingsObject(values[2]);
      profiles.set(rows); if (values[1]) global.set(settingsObject(values[1]));
      defaultID.set(text(settings.defaultGitIdentityId));
      if (!state.ready()) { const value = { gitmojiEnabled: settings.gitmojiEnabled === true, filesViewShowGitignored: settings.filesViewShowGitignored === true, gitChangesViewMode: settings.gitChangesViewMode || 'flat' }; preferences.set(value); initialPreferences.set(value); }
      if (props.entity && !state.ready()) { const item = rows.find(row => row.id === props.entity); if (!item) throw new Error(t('common.unavailable')); draft.set(item); initialDraft.set(item); }
      state.ready.set(true);
    }, operation);
  }
  void load();
  state.observeOperation(operation => { if (operation) void load(operation); });
  async function save(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    let saved = false;
    await state.perform(async (operation) => {
      const value = draft();
      if (!text(value.userName).trim() || !text(value.userEmail).trim()) throw new Error(t('settings.gitIdentities.editor.toast.userNameEmailRequired'));
      if (value.authType === 'token' && !text(value.host).trim()) throw new Error(t('settings.gitIdentities.editor.toast.hostRequiredForToken'));
      if (value.signCommits && !text(value.signingKey).trim()) throw new Error(t('settings.gitIdentities.editor.toast.signingKeyRequired'));
      const body = Object.fromEntries([...gitFields.map(field => field.key), 'authType', 'signCommits'].filter(key => key in value).map(key => [key, value[key]]));
      await operation.transaction(`/api/git/identities${props.create ? '' : '/' + encodeURIComponent(props.entity || '')}`, props.create ? 'POST' : 'PUT', body);
      if (operation.current()) { initialDraft.set(value); saved = true; }
    }, operation);
    if (saved && operation.current()) props.onBack();
  }
  async function savePreferences() {
    await state.perform(async operation => {
      const value = preferences();
      await operation.transaction('/api/config/settings', 'PUT', value);
      if (operation.current()) { initialPreferences.set(value); state.notice.set(t('settings.behavior.page.toast.saved')); }
    });
  }
  async function remove() {
    let removed = false;
    await state.perform(async operation => {
      const answer = await AlertDialog.show({ title: t('settings.common.actions.delete'), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'delete', label: t('settings.common.actions.delete'), role: 'destructive' }] });
      if (answer.action !== 'delete' || !operation.current()) return;
      await operation.transaction(`/api/git/identities/${encodeURIComponent(props.entity || '')}`, 'DELETE');
      if (operation.current()) { initialDraft.set(draft()); removed = true; }
    });
    if (removed && state.current()) props.onBack();
  }
  return <Scroll ref={scroll} onScroll={navigation.onScroll} class="flex-1" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
    <If when={!editing}><GitHubFragment /></If>
    <If when={state.ready() && !editing}>
      <SettingsGroup title={t('settings.gitIdentities.editor.description.globalReadOnly')}><Text class="text-foreground">{text(global().userName)}</Text><Text class="text-muted-foreground">{text(global().userEmail)}</Text></SettingsGroup>
      <SettingsGroup title={t('settings.gitIdentities.page.section.title')}>
        <SettingsChoice title={t('settings.gitIdentities.page.badge.default')} value={defaultID()} disabled={state.busy()} items={[{ value: '', title: t('settings.yuri.defaults.option.default') }, { value: 'global', title: t('settings.gitIdentities.editor.description.globalReadOnly') }, ...profiles().map(row => ({ value: text(row.id), title: text(row.name) }))]} onChange={next => { void state.perform(async (operation) => { await operation.transaction('/api/config/settings', 'PUT', { defaultGitIdentityId: next }); defaultID.set(next); }); }} />
        <Each of={profiles()}>{profile => <Button class="min-h-12 py-3 gap-1" onPress={() => props.onOpen({ page: 'git', entity: text(profile().id) })}><Text class="text-foreground">{text(profile().name) || text(profile().userName)}</Text><Text class="text-xs text-muted-foreground">{text(profile().userEmail)}</Text></Button>}</Each>
        <Button class={settingsAction} onPress={() => props.onOpen({ page: 'git', create: true })}><Text class="text-foreground">{t('settings.gitIdentities.editor.actions.create')}</Text></Button>
      </SettingsGroup>
      <SettingsGroup title={t('settings.yuri.git.title')}>
        <SettingsToggle title={t('settings.yuri.git.enableGitmoji')} value={preferences().gitmojiEnabled === true} disabled={state.busy()} onChange={next => preferences.set({ ...preferences(), gitmojiEnabled: next })} />
        <SettingsToggle title={t('settings.yuri.git.showGitignored')} value={preferences().filesViewShowGitignored === true} disabled={state.busy()} onChange={next => preferences.set({ ...preferences(), filesViewShowGitignored: next })} />
        <SettingsChoice title={t('settings.yuri.git.changesViewTitle')} value={text(preferences().gitChangesViewMode)} items={[{ value: 'flat', title: t('settings.yuri.git.option.flatList') }, { value: 'tree', title: t('settings.yuri.git.option.treeView') }]} onChange={next => preferences.set({ ...preferences(), gitChangesViewMode: next })} />
        <Button class={settingsAction} disabled={state.busy()} onPress={() => { void savePreferences(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button>
      </SettingsGroup>
      <SettingsGitCredentials active={props.active === true} target={props.target} onReveal={node => { void navigation.reveal(node); }} onSaved={() => { void load(); }} />
    </If>
    <If when={state.ready() && editing}>
      <SettingsGroup title={t('settings.gitIdentities.editor.title.editIdentity')}>
        <Each of={gitFields}>{field => <SettingsInput testID={`settings-git-${field().key}`} title={t(field().title)} value={text(draft()[field().key])} disabled={state.busy()} onChange={next => update(field().key, next)} />}</Each>
        <SettingsChoice title={t('settings.gitIdentities.editor.field.authMethod')} value={text(draft().authType) || 'ssh'} disabled={state.busy()} items={[{ value: 'ssh', title: 'SSH' }, { value: 'token', title: t('settings.gitIdentities.editor.field.authToken') }]} onChange={next => update('authType', next)} />
        <SettingsToggle title={t('settings.gitIdentities.editor.field.signCommits')} value={draft().signCommits === true} disabled={state.busy()} onChange={next => update('signCommits', next)} />
      </SettingsGroup>
      <Button class={settingsAction} disabled={state.busy()} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.gitIdentities.editor.actions.save')}</Text></Button>
      <If when={!props.create}><Button class={settingsAction} disabled={state.busy()} onPress={() => { void remove(); }}><Text class="text-destructive">{t('settings.common.actions.delete')}</Text></Button></If>
    </If>
  </Scroll>;
}
