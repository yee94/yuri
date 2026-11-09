import { effect, Scroll, signal, Text, untracked, type ScrollRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { nativeDensity } from './appearance';
import { t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { text, type Row } from './model';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { settingsObject, settingsRows } from './settings-protocol';
import { SettingsGitHub } from './settings-github';
import { SettingsGitCredentials, credentialColors, credentialIcons } from './settings-git-credentials';
import { createSettingsTargetNavigation } from './settings-search-core';

const gitProfilesRevision = signal({ key: '', serial: 0 });

const gitFields: { key: string; title: I18nKey }[] = [
  { key: 'name', title: 'settings.gitIdentities.editor.field.profileName' },
  { key: 'userName', title: 'settings.gitIdentities.editor.field.userName' },
  { key: 'userEmail', title: 'settings.gitIdentities.editor.field.emailAddress' },
  { key: 'host', title: 'settings.gitIdentities.editor.field.host' },
  { key: 'sshKey', title: 'settings.gitIdentities.editor.field.sshKeyPath' },
  { key: 'signingKey', title: 'settings.gitIdentities.editor.field.signingKey' },
];
export function SettingsGit(props: SettingsCallbacks & SettingsRoute & { active?: boolean }) {
  const state = settingsPageLifetime(), profiles = signal<Row[]>([]), global = signal<Row>({}), draft = signal<Row>({ id: props.entity || `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, name: '', userName: '', userEmail: '', authType: 'ssh', signCommits: false, color: 'keyword', icon: 'branch' });
  const pending = signal<{ method: string; body?: Row; id: string } | null>(null);
  const completed = signal(false);
  let readVersion = 0;
  const changed = () => gitProfilesRevision.set({ key: state.identityKey, serial: gitProfilesRevision().serial + 1 });
  function adopted() { completed.set(true); pending.set(null); changed(); props.onBack(); }
  function reconcile(rows: Row[]) {
    const expected = pending(); if (!expected) return;
    if (expected.method === 'DELETE' ? !rows.some(row => row.id === expected.id) : rows.some(row => row.id === expected.id && Object.entries(expected.body || {}).every(([key, value]) => row[key] === value))) adopted();
    else throw new Error(t('settings.github.native.unknown'));
  }

  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, state.current, () => state.operation()?.current ?? (() => false));
  const defaultID = signal(''), preferences = signal<Row>({});
  const editing = !!props.entity || !!props.create;
  const update = (key: string, value: unknown) => { if (!state.current() || state.busy() || pending() || completed()) return; draft.set({ ...draft(), [key]: value }); };
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      const ticket = ++readVersion;
      const values = await Promise.all([operation.request('/api/git/identities'), operation.request('/api/git/global-identity'), operation.request('/api/config/settings')]);
      if (!operation.current() || ticket !== readVersion) return;
      const rows = settingsRows(values[0]), settings = settingsObject(values[2]);
      profiles.set(rows); if (values[1]) global.set(settingsObject(values[1]));
      defaultID.set(text(settings.defaultGitIdentityId));
      if (!state.ready()) preferences.set({ gitmojiEnabled: settings.gitmojiEnabled === true, filesViewShowGitignored: settings.filesViewShowGitignored === true, gitChangesViewMode: settings.gitChangesViewMode || 'flat' });
      if (props.entity && !state.ready()) { const item = rows.find(row => row.id === props.entity); if (!item) throw new Error(t('common.unavailable')); draft.set(item); }
      state.ready.set(true);
      reconcile(rows);
    }, operation);
  }
  void load();
  state.observeOperation(operation => { if (operation) void load(operation); });
  let seenRevision = gitProfilesRevision().serial;
  let refreshNeeded = false, previouslyActive = props.active === true;
  effect(() => {
    const revision = gitProfilesRevision(), active = props.active === true, busy = state.busy(), current = state.current();
    const changedRevision = revision.serial !== seenRevision && revision.key === state.identityKey;
    if (changedRevision || active && !previouslyActive) refreshNeeded = true;
    previouslyActive = active;
    if (!editing && refreshNeeded && !busy && current) { seenRevision = revision.serial; refreshNeeded = false; untracked(() => { void load(); }); }
  });
  async function save(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      if (completed()) { props.onBack(); return; }
      if (pending()) {
        const rows = settingsRows(await operation.request('/api/git/identities'));
        if (operation.current()) reconcile(rows);
        return;
      }
      const value = draft();
      if (!text(value.userName).trim() || !text(value.userEmail).trim()) throw new Error(t('settings.gitIdentities.editor.toast.userNameEmailRequired'));
      if (value.authType === 'token' && !text(value.host).trim()) throw new Error(t('settings.gitIdentities.editor.toast.hostRequiredForToken'));
      if (value.signCommits && !text(value.signingKey).trim()) throw new Error(t('settings.gitIdentities.editor.toast.signingKeyRequired'));
      const body: Row = { id: value.id, name: text(value.name).trim() || text(value.userName).trim(), userName: text(value.userName).trim(), userEmail: text(value.userEmail).trim(), authType: value.authType || 'ssh', signCommits: value.signCommits === true,
        host: value.authType === 'token' ? text(value.host).trim() || null : null, sshKey: value.authType === 'token' ? null : text(value.sshKey).trim() || null, signingKey: text(value.signingKey).trim() || null, color: value.color || 'keyword', icon: value.icon || 'branch' };
      const submission = { id: text(body.id), method: props.create ? 'POST' : 'PUT', body };
      pending.set(submission);
      ++readVersion;
      const result = await operation.transaction(`/api/git/identities${props.create ? '' : '/' + encodeURIComponent(props.entity || '')}`, submission.method, body);
      if (!operation.current()) return;
      if (!Object.entries(body).every(([key, value]) => result[key] === value)) throw new Error(t('settings.github.native.unknown'));
      adopted();
    }, operation);
  }
  return <Scroll ref={scroll} onScroll={navigation.onScroll} class="flex-1" contentClass="p-5 gap-5 pb-10" contentStyle={nativeDensity().pages.settings}>
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
    <If when={!editing}><SettingsGitHub active={props.active === true} target={props.target} onReveal={node => { void navigation.reveal(node); }} /></If>
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
        <Button class={settingsAction} disabled={state.busy()} onPress={() => { void state.perform(async (operation) => { await operation.transaction('/api/config/settings', 'PUT', preferences()); state.notice.set(t('settings.behavior.page.toast.saved')); }); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button>
      </SettingsGroup>
      <SettingsGitCredentials active={props.active === true} target={props.target} onReveal={node => { void navigation.reveal(node); }} onSaved={() => { void load(); }} />
    </If>
    <If when={state.ready() && editing}>
      <SettingsGroup title={t('settings.gitIdentities.editor.title.editIdentity')}>
        <Each of={gitFields.filter(field => field.key !== 'host' && field.key !== 'sshKey' || field.key === 'host' && draft().authType === 'token' || field.key === 'sshKey' && draft().authType !== 'token')}>{field => <SettingsInput testID={`settings-git-${field().key}`} title={t(field().title)} value={text(draft()[field().key])} disabled={state.busy() || !!pending() || completed()} onChange={next => update(field().key, next)} />}</Each>
        <SettingsChoice testID="settings-git-color" title={t('settings.gitIdentities.editor.field.color')} value={text(draft().color) || 'keyword'} disabled={state.busy() || !!pending() || completed()} items={credentialColors.map(value => ({ value, title: t(`settings.github.native.color.${value}`) }))} onChange={next => update('color', next)} />
        <SettingsChoice testID="settings-git-icon" title={t('settings.gitIdentities.editor.field.icon')} value={text(draft().icon) || 'branch'} disabled={state.busy() || !!pending() || completed()} items={credentialIcons.map(value => ({ value, title: t(`settings.github.native.icon.${value}`) }))} onChange={next => update('icon', next)} />
        <SettingsChoice testID="settings-git-auth" title={t('settings.gitIdentities.editor.field.authMethod')} value={text(draft().authType) || 'ssh'} disabled={state.busy() || !!pending() || completed()} items={[{ value: 'ssh', title: 'SSH' }, { value: 'token', title: t('settings.gitIdentities.editor.field.authToken') }]} onChange={next => update('authType', next)} />
        <SettingsToggle title={t('settings.gitIdentities.editor.field.signCommits')} value={draft().signCommits === true} disabled={state.busy() || !!pending() || completed()} onChange={next => update('signCommits', next)} />
      </SettingsGroup>
      <Button testID="settings-git-save" class={settingsAction} disabled={state.busy()} onPress={() => { void save(); }}><Text class="text-foreground">{t(completed() ? 'gitView.common.done' : pending() ? 'settings.voice.volcengine.retry' : 'settings.gitIdentities.editor.actions.save')}</Text></Button>
      <If when={!props.create}><Button testID="settings-git-delete" class={settingsAction} disabled={state.busy() || !!pending() || completed()} onPress={() => { void state.perform(async (operation) => { if (pending() || completed()) return; const answer = await AlertDialog.show({ title: t('settings.common.actions.delete'), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'delete', label: t('settings.common.actions.delete'), role: 'destructive' }] }); if (answer.action !== 'delete' || !operation.current()) return; pending.set({ id: props.entity || '', method: 'DELETE' }); ++readVersion; await operation.transaction(`/api/git/identities/${encodeURIComponent(props.entity || '')}`, 'DELETE'); if (!operation.current()) return; adopted(); }); }}><Text class="text-destructive">{t('settings.common.actions.delete')}</Text></Button></If>
    </If>
  </Scroll>;
}
