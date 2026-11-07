import { effect, Scroll, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button, TextView } from 'nsh/base';
import { t } from './i18n';
import { Icon } from './Icon';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { record, text, type Row } from './model';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsProviders } from './settings-providers';
import { SettingsSkillFiles } from './settings-skill-files';
import { SettingsPermissions, SettingsSavedPermissions } from './settings-permissions';
import { SettingsMcpLive } from './settings-mcp-live';
import { SettingsPluginRuntime } from './settings-plugin-runtime';
import { SettingsMcpImport } from './settings-mcp-import';
import { nativeAgentEditor, nativeAgentPatch, nativeCollectionChanges } from './settings-collections-core';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { readSettingsCollection, scopedSettingsPath, settingsMutation, settingsObject, settingsSkillReadOnly, type SettingsDomain } from './settings-protocol';

type Props = SettingsCallbacks & SettingsRoute & { directory?: string; active?: boolean };
const collectionRevision = signal({ key: '', revision: 0 });
export function SettingsCollection(props: Props) {
  if (props.page === 'providers') return <SettingsProviders {...props} />;
  const domain = props.page as SettingsDomain;
  const directory = props.directory;
  const state = settingsPageLifetime(), rows = signal<Row[]>([]), draft = signal<Row>({ scope: 'user', name: '', type: 'local', enabled: true, mode: 'primary' });

  const changed = signal<Row>({}), original = signal<Row>({}), initial = signal<Row>({});
  const name = signal(props.create ? '' : props.entity || '');
  const options = signal('{}'), committed = signal(false);
  const importing = signal(false), pluginBusy = signal(false);
  const editing = !!props.entity || !!props.create;
  const revisionKey = `${state.identityKey}:${domain}:${directory || ''}`;
  const invalidate = () => collectionRevision.set({ key: revisionKey, revision: collectionRevision().revision + 1 });
  const readOnly = () => domain === 'skills.installed' && settingsSkillReadOnly(original());
  const value = (key: string) => typeof draft()[key] === 'number' ? String(draft()[key]) : text(draft()[key]);
  const current = () => state.current() && props.directory === directory;
  const locked = () => !current() || state.busy() || pluginBusy() || !state.ready() || committed() || readOnly();
  const changes = () => nativeCollectionChanges(draft(), initial(), changed());
  function set(key: string, value: unknown) { if (locked()) return; draft.set({ ...draft(), [key]: value }); changed.set({ ...changed(), [key]: value }); }
  function field(key: string, title: I18nKey, multiline = false) {
    if (readOnly()) return <View class="gap-2"><Text class="text-sm text-foreground">{t(title)}</Text><TextView markdown={value(key)} selectable class="text-foreground" /></View>;
    return <SettingsInput testID={`settings-${key}`} title={t(title)} value={value(key)} multiline={multiline} disabled={locked()} onChange={next => set(key, next)} />;
  }
  function choice(key: string, title: I18nKey, values: string[]) {
    const labels: Record<string, I18nKey> = { user: 'settings.plugins.scope.user', project: 'settings.plugins.scope.project', primary: 'settings.agents.page.mode.primary', subagent: 'settings.agents.page.mode.subagent', all: 'settings.agents.page.mode.all', local: 'settings.mcp.page.transport.local', remote: 'settings.mcp.page.transport.remote' };
    return <SettingsChoice title={t(title)} value={value(key)} disabled={locked()} items={values.map(item => ({ value: item, title: labels[item] ? t(labels[item]) : item }))} onChange={next => set(key, next)} />;
  }
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      if (props.create) { state.ready.set(true); return; }
      if (!(operation.current() && current())) return;
      const loaded = await readSettingsCollection(operation.request, domain, directory);
      if (!(operation.current() && current())) return;
      rows.set(loaded);
      if (editing && !state.ready()) {
        let item = loaded.find(row => String(row.id || row.name) === props.entity);
        if (!item) throw new Error(t('settings.agents.sidebar.toast.definitionNotFound'));
        if (domain === 'skills.installed') {
          const detail = settingsObject(await operation.request(scopedSettingsPath(`/api/config/skills/${encodeURIComponent(name())}`, directory)));
          const source = record(record(detail.sources).md);
          item = { ...item, ...detail, description: source.description ?? item.description, instructions: source.instructions, targetPath: source.path, supportingFiles: source.supportingFiles };
        }
        if (domain === 'plugins' && item.file) item = { ...item, ...settingsObject(await operation.request(scopedSettingsPath(`/api/config/plugins/file/${encodeURIComponent(name())}`, directory))) };
        if (domain === 'agents') item = await nativeAgentEditor(operation.request, item, directory);
        if (!(operation.current() && current())) return;
        original.set(item);
        if (domain !== 'plugins') name.set(text(item.name) || name());
        const next = { ...item, scope: item.scope || 'user' };
        draft.set(next); initial.set(next); changed.set({});
        options.set(JSON.stringify(item.options || {}, null, 2));
      }
      state.ready.set(true);
    }, operation);
  }
  void load();
  state.observeOperation(operation => { if (operation) void load(operation); });
  let seenRevision = collectionRevision().revision;
  effect(() => {
    const next = collectionRevision();
    if (next.revision === seenRevision) return;
    seenRevision = next.revision;
    if (!editing && next.key === revisionKey) untracked(() => { if (current()) void load(); });
  });
  async function save(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (locked() || importing()) return;
    await state.perform(async (operation) => {
      if (domain !== 'plugins' && !name().trim()) throw new Error(t('settings.mcp.page.toast.nameRequired'));
      const edits = domain === 'agents' ? nativeAgentPatch(changes()) : changes();
      const body: Row = props.create ? { ...draft(), name: name().trim() } : { ...edits, scope: draft().scope };
      if (domain === 'mcp') {
        const command = draft().command;
        if (draft().type === 'local' && (!Array.isArray(command) || !command.length)) throw new Error(t('settings.mcp.page.toast.localCommandRequired'));
        if (draft().type === 'remote' && !value('url').trim()) throw new Error(t('settings.mcp.page.toast.remoteUrlRequired'));
      }
      if (domain === 'commands' && !value('template').trim()) throw new Error(t('settings.commands.page.toast.templateRequired'));
      if (domain === 'skills.installed') {
        if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name())) throw new Error(t('settings.skills.page.toast.invalidSkillName'));
        if (!value('description').trim()) throw new Error(t('settings.skills.page.toast.descriptionRequired'));
        if (!props.create && original().targetPath) body.targetPath = original().targetPath;
      }
      if (domain === 'plugins') {
        if (!value('spec').trim() && !original().file) throw new Error(t('settings.plugins.validation.specRequired'));
        if (!original().file) {
          try { const parsed = settingsObject(JSON.parse(options())); if (props.create || options() !== JSON.stringify(original().options || {}, null, 2)) body.options = parsed; }
          catch { throw new Error(t('settings.plugins.page.field.options.invalidJson')); }
        }
      }
      if ('steps' in body) {
        const steps = Number(body.steps);
        if (!Number.isSafeInteger(steps) || steps < 1) throw new Error(t('assistants.state.invalidConfiguration'));
        body.steps = steps;
      }
      if ('timeout' in body && body.timeout !== null && body.timeout !== '') {
        const timeout = Number(body.timeout);
        if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error(t('assistants.state.invalidConfiguration'));
        body.timeout = timeout;
      }
      if (body.timeout === '') body.timeout = null;
      const mutation = settingsMutation(domain, name().trim(), body, !!props.create, directory);
      if (domain === 'plugins' && original().file) {
        mutation.path = scopedSettingsPath(`/api/config/plugins/file/${encodeURIComponent(name())}`, directory);
        mutation.method = 'PUT'; mutation.body = { content: draft().content };
      }
      const result = await operation.transaction(mutation.path, mutation.method, mutation.body);
      if (!(operation.current() && current())) return;
      committed.set(true);
      if (domain === 'plugins') original.set({ ...original(), ...draft(), ...(body.options ? { options: body.options } : {}) });
      invalidate();
      const success: I18nKey = domain === 'commands' ? 'settings.commands.page.toast.updated' : domain === 'skills.installed' ? 'settings.skills.page.toast.skillUpdated' : domain === 'plugins' ? 'settings.plugins.toast.updated' : domain === 'mcp' ? 'settings.mcp.page.toast.savedReloading' : 'settings.agents.page.toast.savedNextRequest';
      state.notice.set(t(result.requiresManualRestart ? 'settings.agents.page.toast.savedManualRestart' : result.reloadFailed ? 'settings.mcp.page.toast.savedReloadFailed' : success));
    }, operation);
  }
  const title = () => domain === 'mcp' ? t('settings.mcp.page.server.title') : domain === 'plugins' ? t('settings.plugins.page.header.entry') : domain === 'commands' ? t('settings.commands.page.section.identity') : t('settings.agents.page.section.identityRole');
  return <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
    <If when={!editing}>
      <If when={domain === 'agents'}><SettingsSavedPermissions directory={props.directory} /></If>
      <Button testID="settings-refresh" class={settingsAction} accessibilityLabel={t('sidebarFilesTree.actions.refreshTitle')} disabled={state.busy()} onPress={() => { void load(); }}><Icon name="refresh" /></Button>
      <Button class={settingsAction} onPress={() => props.onOpen({ page: props.page, create: true })}><Text class="text-foreground">{t('settings.plugins.dialog.add.action.submit')}</Text></Button>
      <SettingsGroup title={title()}><Each of={rows()}>{item => <Button class="min-h-12 py-3 gap-1 border-b border-border" onPress={() => props.onOpen({ page: props.page, entity: text(item().id) || text(item().name) })}>
        <Text class="text-base text-foreground">{text(item().name) || text(item().spec) || text(item().filename) || text(item().id)}</Text><Text class="text-xs text-muted-foreground">{text(item().description) || text(item().scope)}</Text>
      </Button>}</Each><If when={state.ready() && !rows().length}><Text class="text-muted-foreground">{t('settings.plugins.page.empty.add')}</Text></If></SettingsGroup>
    </If>
    <If when={editing && state.ready()}>
      <SettingsGroup title={title()}>
        <If when={domain !== 'plugins' || !!original().file}><SettingsInput title={t(domain === 'commands' ? 'settings.commands.page.field.commandName' : domain === 'mcp' ? 'settings.mcp.page.server.name' : domain === 'skills.installed' ? 'settings.skills.page.field.skillNameLocation' : domain === 'plugins' ? 'settings.plugins.page.field.fileName' : 'settings.agents.page.field.agentName')} value={name()} disabled={!props.create || state.busy() || committed()} onChange={next => name.set(next)} /></If>
        <If when={!!props.create}>{choice('scope', 'settings.agents.page.field.scope', props.directory ? ['user', 'project'] : ['user'])}</If>
        <If when={domain !== 'plugins'}>{field('description', domain === 'commands' ? 'settings.commands.page.field.descriptionPlaceholder' : domain === 'skills.installed' ? 'settings.skills.page.field.descriptionPlaceholder' : 'settings.agents.page.field.descriptionPlaceholder')}</If>
        <If when={domain === 'agents'}>
          {choice('mode', 'settings.agents.page.field.mode', ['primary', 'subagent', 'all'])}
          {field('model', 'settings.agents.page.field.overrideModel')}
          {field('steps', 'settings.agents.page.field.steps')}
          <SettingsToggle title={t('settings.agents.page.field.hidden')} value={draft().hidden === true} disabled={state.busy() || committed()} onChange={next => set('hidden', next)} />
          <SettingsToggle title={t('settings.agents.page.field.disabled')} value={draft().disabled === true} disabled={state.busy() || committed()} onChange={next => set('disabled', next)} />
          {field('system', 'settings.agents.page.section.systemPrompt', true)}
          <SettingsPermissions rules={Array.isArray(draft().permissions) ? draft().permissions as Row[] : []} disabled={state.busy() || committed()} onChange={next => set('permissions', next)} />
        </If>
        <If when={domain === 'commands'}>{field('agent', 'settings.commands.page.field.overrideAgent')}{field('model', 'settings.agents.page.field.overrideModel')}{field('template', 'settings.commands.page.section.template', true)}</If>
        <If when={domain === 'skills.installed'}>{field('instructions', 'settings.skills.page.section.instructions', true)}<SettingsSkillFiles name={name()} directory={props.directory} files={Array.isArray(original().supportingFiles) ? original().supportingFiles as Row[] : []} create={props.create} readOnly={readOnly()} disabled={state.busy() || committed()} onDraft={next => set('supportingFiles', next)} /></If>
        <If when={domain === 'mcp'}>
          {choice('type', 'settings.mcp.page.server.transportMode', ['local', 'remote'])}
          <SettingsToggle title={t('settings.mcp.page.server.enable')} value={draft().enabled !== false} disabled={state.busy() || committed()} onChange={next => set('enabled', next)} />
           <If when={!!props.create}><SettingsMcpImport name={name()} disabled={locked()} onOpenChange={next => importing.set(next)} onImport={(nextName, fields) => { if (locked()) return; name.set(nextName); draft.set({ ...draft(), ...fields }); changed.set({ ...changed(), ...fields }); state.notice.set(t('settings.mcp.page.toast.configImported')); }} /></If>
           <If when={draft().type === 'local'}><SettingsInput title={t('settings.mcp.page.connection.command')} disabled={locked()} multiline value={Array.isArray(draft().command) ? (draft().command as string[]).join('\n') : ''} onChange={next => set('command', next.split('\n').filter(line => line.length > 0))} /></If>
            <If when={draft().type === 'remote'}>
              <SettingsInput testID="settings-url" title={t('settings.mcp.page.connection.serverUrl')} value={value('url')} disabled={locked()} onChange={next => set('url', next)} />
              <SettingsInput testID="settings-timeout" title={t('settings.mcp.page.advanced.timeoutMs')} value={value('timeout')} disabled={locked()} onChange={next => set('timeout', next)} />
              <SettingsToggle title={t('settings.mcp.page.advanced.oauthAutoDetection')} value={draft().oauth !== false} disabled={locked()} onChange={next => set('oauth', next ? {} : false)} />
             <If when={draft().oauth !== false}><Each of={[
               ['clientId', 'settings.mcp.page.advanced.oauthClientIdPlaceholder'], ['clientSecret', 'settings.mcp.page.advanced.oauthClientSecretPlaceholder'], ['scope', 'settings.mcp.page.advanced.oauthScopesPlaceholder'], ['redirectUri', 'settings.mcp.page.advanced.oauthRedirectUriPlaceholder'],
             ] as const}>{pair => <SettingsInput testID={`mcp-oauth-${pair()[0]}`} title={t(pair()[1])} value={text(record(draft().oauth)[pair()[0]])} masked={pair()[0] === 'clientSecret'} disabled={locked()} onChange={next => { const oauth = { ...record(draft().oauth) }; if (next.trim()) oauth[pair()[0]] = next; else delete oauth[pair()[0]]; set('oauth', oauth); }} />}</Each></If>
           </If>
          <Each of={draft().type === 'remote' ? ['environment', 'headers'] : ['environment']}>{mapKey => <SettingsGroup title={t(mapKey() === 'headers' ? 'settings.mcp.page.advanced.requestHeaders' : 'settings.mcp.page.env.title')}><Each of={Object.entries(record(draft()[mapKey()]))}>{pair => <View class="flex-row items-center gap-2"><Text class="text-sm text-foreground">{pair()[0]}</Text><SettingsInput title={t('settings.mcp.page.env.value')} masked value={String(pair()[1])} onChange={next => set(mapKey(), { ...record(draft()[mapKey()]), [pair()[0]]: next })} /><Button class={settingsAction} onPress={() => { const next = { ...record(draft()[mapKey()]) }; delete next[pair()[0]]; set(mapKey(), next); }}><Text class="text-foreground">{t('mobile.instances.delete')}</Text></Button></View>}</Each><SettingsInput title={t('settings.mcp.page.env.key')} value={value(mapKey() + 'NewKey')} onChange={next => set(mapKey() + 'NewKey', next)} /><Button class={settingsAction} onPress={() => { const key = value(mapKey() + 'NewKey').trim(); if (key) set(mapKey(), { ...record(draft()[mapKey()]), [key]: '' }); }}><Text class="text-foreground">{t('settings.mcp.page.env.addVariable')}</Text></Button></SettingsGroup>}</Each>
        </If>
         <If when={domain === 'plugins' && !original().file}>{field('spec', 'settings.plugins.page.field.spec')}<SettingsInput title={t('settings.plugins.page.field.options')} disabled={locked()} multiline value={options()} onChange={next => options.set(next)} /></If>
        <If when={domain === 'plugins' && original().file}>{field('content', 'settings.plugins.page.field.content', true)}</If>
      </SettingsGroup>
      <If when={domain === 'plugins' && !props.create}><SettingsPluginRuntime item={original()} directory={props.directory} disabled={state.busy() || (!committed() && (Object.keys(changes()).length > 0 || options() !== JSON.stringify(original().options || {}, null, 2)))} onBusy={busy => pluginBusy.set(busy)} onUpdated={spec => { if (spec) { original.set({ ...original(), spec }); draft.set({ ...draft(), spec }); } committed.set(true); invalidate(); }} /></If>
      <If when={domain === 'mcp' && !props.create && !committed()}><SettingsMcpLive name={name()} directory={props.directory} disabled={state.busy() || Object.keys(changed()).length > 0} /></If>
       <If when={!committed() && !readOnly()}><Button class={settingsAction} disabled={locked() || importing() || (!props.create && !Object.keys(changes()).length && (domain !== 'plugins' || options() === JSON.stringify(original().options || {}, null, 2)))} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button></If>
      <If when={committed()}><Button class={settingsAction} onPress={props.onBack}><Text class="text-foreground">{t('gitView.common.done')}</Text></Button></If>
      <If when={!props.create && !committed() && !readOnly()}><Button class={settingsAction} disabled={locked()} onPress={() => { if (locked()) return; void state.perform(async (operation) => { if (readOnly()) return; const choice = await AlertDialog.show({ title: t('settings.mcp.page.deleteDialog.title', { name: name() }), actions: [{ id: 'cancel', label: t('settings.plugins.dialog.add.action.cancel'), role: 'cancel' }, { id: 'delete', label: t('mobile.instances.delete'), role: 'destructive' }] }); if (choice.action !== 'delete' || !(operation.current() && current())) return; const mutation = settingsMutation(domain, name(), {}, false, directory); const path = original().file ? scopedSettingsPath(`/api/config/plugins/file/${encodeURIComponent(name())}`, directory) : mutation.path; await operation.transaction(path, 'DELETE', domain === 'agents' ? { scope: draft().scope } : undefined); if (!(operation.current() && current())) return; invalidate(); props.onBack(); }); }}><Text class="text-destructive">{t('mobile.instances.delete')}</Text></Button></If>
    </If>
  </Scroll>;
}
