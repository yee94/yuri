import { effect, Scroll, signal, Text, untracked, View, type ViewRef, type ScrollRef } from 'nsh';
import { AlertDialog, Button, TextView } from 'nsh/base';
import { t } from './i18n';
import { nativeCodeTextViewStyles, nativeDensity } from './appearance';
import { nativeEditorTextStyle } from './native-editor-style';
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
import { nativeAgentEditor, nativeAgentPatch, nativeCollectionChanges, nativeCollectionDraft } from './settings-collections-core';
import { collectionCopyName, createCollectionRename } from './settings-collection-operations';
import { createCollectionJSONCCopy, collectionJSONCEntry, type CollectionJSONCSource } from './settings-collection-jsonc';
import { createNativeAgentScopeMove } from './settings-collection-scope';
import { SettingsCollectionKV } from './settings-collection-kv';
import { SettingsCollectionPicker } from './settings-collection-picker';
import { SettingsCollectionPlugins } from './settings-collection-plugins';
import { SettingsCollectionDirectory } from './settings-collection-directory';
import { NativeSheet } from './native-sheet';
import { createSettingsTargetNavigation, prepareCollectionSearchTarget } from './settings-search-core';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { readSettingsCollection, scopedSettingsPath, settingsMutation, settingsObject, settingsSkillReadOnly, type SettingsDomain } from './settings-protocol';

export type SettingsCollectionDraft = { editor: Row; config: Row; jsonc?: CollectionJSONCSource };
type CollectionRenameSource = { item: Row; snapshot: SettingsCollectionDraft };
export type SettingsCollectionNavigation = { blocked: boolean; back: () => void };
export type SettingsCollectionRoute = SettingsRoute & { collectionDraft?: SettingsCollectionDraft };
export type SettingsCollectionCallbacks = {
  onCollectionDirectory?: (directory: string | undefined, route: SettingsCollectionRoute) => void;
  onCollectionNavigation?: (navigation: SettingsCollectionNavigation) => void;
};
type Props = SettingsCallbacks & SettingsCollectionRoute & SettingsCollectionCallbacks & { directory?: string; active?: boolean };
const collectionRevision = signal({ key: '', revision: 0 });
export function SettingsCollection(props: Props) {
  if (props.page === 'providers') return <SettingsProviders {...props} />;
  const domain = props.page as SettingsDomain;
  const directory = props.directory;
  const state = settingsPageLifetime(() => props.active !== false), rows = signal<Row[]>([]), draft = signal<Row>({ scope: 'user', name: '', type: 'local', enabled: true, mode: 'primary' });

  const changed = signal<Row>({}), original = signal<Row>({}), initial = signal<Row>({});
  const name = signal(props.create ? text(props.collectionDraft?.editor.name) : props.entity || '');
  const options = signal('{}'), committed = signal(false);
  const importing = signal(false), pluginBusy = signal(false);
  const writePending = signal(false);
  let copyJournal: ReturnType<typeof createCollectionJSONCCopy> | undefined;
  let scopeJournal: ReturnType<typeof createNativeAgentScopeMove> | undefined;
  const pendingPhase = () => scopeJournal?.phase() || copyJournal?.phase();
  const prepared = prepareCollectionSearchTarget(props.page, props.target);
  const creating = !!props.create || !!prepared?.create;
  const editing = !!props.entity || creating;
  const renameOpen = signal(false), renameName = signal(''), renameRevision = signal(0);
  let renameSource: CollectionRenameSource | null = null;
  let renameOperation: ReturnType<typeof createCollectionRename> | null = null;
  const renameJournals = new Map<string, { operation: ReturnType<typeof createCollectionRename>; source: CollectionRenameSource; nextName: string }>();
  const renamePhase = () => { renameRevision(); return renameOperation?.phase(); };
  let scroll: ScrollRef | undefined;
  const navigation = createSettingsTargetNavigation(() => scroll, () => current(), () => state.operation()?.current ?? (() => false));
  const targets = new Map<string, ViewRef>();
  const anchor = (id: string) => (ref: ViewRef) => { targets.set(id, ref); };
  const reveal = (id: string) => { const ref = targets.get(id); if (props.target === id && ref) void navigation.reveal(ref); };
  const revisionKey = `${state.identityKey}:${domain}:${directory || ''}`;
  const invalidate = () => collectionRevision.set({ key: revisionKey, revision: collectionRevision().revision + 1 });
  const readOnly = () => domain === 'skills.installed' && settingsSkillReadOnly(original());
  const value = (key: string) => typeof draft()[key] === 'number' ? String(draft()[key]) : text(draft()[key]);
  const current = () => state.current() && props.directory === directory;
  const locked = () => !current() || state.busy() || pluginBusy() || !state.ready() || committed() || readOnly() || writePending();
  const changes = () => nativeCollectionChanges(draft(), initial(), changed());
  const dirty = () => writePending() || editing && !committed() && (creating || Object.keys(changes()).length > 0 || domain === 'plugins' && options() !== JSON.stringify(original().options || {}, null, 2));
  const back = async () => {
    if (state.busy() || pluginBusy()) return;
    const operation = state.operation(); if (!operation?.current()) return;
    if (!dirty()) { props.onBack(); return; }
    const answer = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t(writePending() ? 'settings.yuri.sessionRetention.result.uncertain' : 'sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' }] });
    if (answer.action === 'discard' && operation.current()) props.onBack();
  };
  effect(() => { const blocked = state.busy() || pluginBusy() || dirty(); untracked(() => props.onCollectionNavigation?.({ blocked, back: () => { void back(); } })); });
  function set(key: string, value: unknown) { if (locked()) return; draft.set({ ...draft(), [key]: value }); changed.set({ ...changed(), [key]: value }); }
  function field(key: string, title: I18nKey, multiline = false) {
    if (readOnly()) return <View class="gap-2"><Text class="text-sm text-foreground">{t(title)}</Text><TextView markdown={value(key)} selectable styles={nativeCodeTextViewStyles()} class="text-foreground" /></View>;
    const target = key === 'system' ? 'system-prompt' : key;
    const id = `${domain === 'skills.installed' ? 'skills' : domain}.${target}`;
    return <View testID={`settings-target-${id}`} ref={anchor(id)} onLayout={() => reveal(id)} class={props.target === id ? 'rounded-xl bg-accent gap-2' : 'gap-2'}><SettingsInput testID={`settings-${key}`} title={t(title)} value={value(key)} multiline={multiline} inputStyle={domain === 'skills.installed' && key === 'instructions' ? nativeEditorTextStyle() : undefined} disabled={locked()} onChange={next => set(key, next)} /></View>;
  }
  function choice(key: string, title: I18nKey, values: string[]) {
    const labels: Record<string, I18nKey> = { user: 'settings.plugins.scope.user', project: 'settings.plugins.scope.project', primary: 'settings.agents.page.mode.primary', subagent: 'settings.agents.page.mode.subagent', all: 'settings.agents.page.mode.all', local: 'settings.mcp.page.transport.local', remote: 'settings.mcp.page.transport.remote' };
    return <SettingsChoice title={t(title)} value={value(key)} disabled={locked()} items={values.map(item => ({ value: item, title: labels[item] ? t(labels[item]) : item }))} onChange={next => set(key, next)} />;
  }
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      if (creating) {
        if (!state.ready()) {
          const next = { ...draft(), ...props.collectionDraft?.editor, ...(prepared?.draft || {}) };
          if (!directory && next.scope === 'project') next.scope = 'user';
          draft.set(next); initial.set(next); changed.set({});
        }
        state.ready.set(true); return;
      }
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
  state.observeOperation(operation => { copyJournal?.replaceLane(operation); scopeJournal?.replaceLane(operation); for (const journal of renameJournals.values()) journal.operation.replaceLane(operation); if (operation) void load(operation); });
  let seenRevision = collectionRevision().revision;
  effect(() => {
    const next = collectionRevision();
    if (next.revision === seenRevision) return;
    seenRevision = next.revision;
    if (!editing && next.key === revisionKey) untracked(() => { if (current()) void load(); });
  });
  async function save(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (locked() && !writePending() || importing() || state.busy() || !current()) return;
    await state.perform(async (operation) => {
      if (domain !== 'plugins' && !name().trim()) throw new Error(t('settings.mcp.page.toast.nameRequired'));
      const edits = domain === 'agents' ? nativeAgentPatch(changes()) : changes();
      const body: Row = creating ? { ...draft(), name: name().trim() } : { ...edits, scope: draft().scope };
      if (domain === 'mcp') {
        const command = draft().command;
        if (draft().type === 'local' && (!Array.isArray(command) || !command.length)) throw new Error(t('settings.mcp.page.toast.localCommandRequired'));
        if (draft().type === 'remote' && !value('url').trim()) throw new Error(t('settings.mcp.page.toast.remoteUrlRequired'));
      }
      if (domain === 'commands' && !value('template').trim()) throw new Error(t('settings.commands.page.toast.templateRequired'));
      if (domain === 'skills.installed') {
        if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name())) throw new Error(t('settings.skills.page.toast.invalidSkillName'));
        if (!value('description').trim()) throw new Error(t('settings.skills.page.toast.descriptionRequired'));
        if (!creating && original().targetPath) body.targetPath = original().targetPath;
      }
      if (domain === 'plugins') {
        if (!value('spec').trim() && !original().file) throw new Error(t('settings.plugins.validation.specRequired'));
        if (!original().file) {
          try { const parsed = settingsObject(JSON.parse(options())); if (creating || options() !== JSON.stringify(original().options || {}, null, 2)) body.options = parsed; }
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
      const mutation = settingsMutation(domain, name().trim(), body, creating, directory);
      if (creating && props.collectionDraft && ['agents', 'commands', 'skills.installed'].includes(domain)) {
        const raw = { ...props.collectionDraft.config };
        for (const [key, value] of Object.entries({ ...edits, ...('steps' in body ? { steps: body.steps } : {}) })) { if (domain === 'agents' && key === 'system') raw.prompt = value; else raw[key] = value; }
        mutation.body = { ...raw, ...(domain === 'skills.installed' ? { name: name().trim() } : {}), scope: draft().scope };
      }
      if (domain === 'plugins' && original().file) {
        mutation.path = scopedSettingsPath(`/api/config/plugins/file/${encodeURIComponent(name())}`, directory);
        mutation.method = 'PUT'; mutation.body = { content: draft().content };
      }
      let result: Row = {};
      if (!creating && domain === 'agents' && original().isBuiltIn !== true && (scopeJournal || draft().scope !== initial().scope)) {
        if (!scopeJournal) {
          const from = initial().scope, to = draft().scope;
          if ((from !== 'user' && from !== 'project') || (to !== 'user' && to !== 'project')) throw new Error(t('assistants.state.invalidConfiguration'));
          scopeJournal = createNativeAgentScopeMove({ name: name(), from, to, directory, patch: body }, operation.request, operation.current);
        }
        const journal = scopeJournal;
        writePending.set(true);
        try { await journal.advance(); }
        finally { const phase = journal.phase(); writePending.set(phase !== 'draft' && phase !== 'done'); if (phase === 'draft') scopeJournal = undefined; }
        if (!operation.current()) return;
        if (journal.phase() !== 'done') { state.notice.set(t('settings.agents.sidebar.toast.removeOldAfterRenameFailed')); return; }
        writePending.set(false);
      } else if (creating && domain === 'commands' && props.collectionDraft?.jsonc) {
        const snapshot = props.collectionDraft;
        if (!copyJournal) {
          const jsonc = snapshot.jsonc!;
          const to = draft().scope;
          const sameProjectFile = to === 'project' && jsonc.scope === 'project' && directory && jsonc.path.startsWith(`${directory.replace(/\/$/, '')}/`);
          const destination = to === 'user' ? { path: '', global: true } : sameProjectFile ? undefined : directory ? { path: `${directory.replace(/\/$/, '')}/.opencode/opencode.jsonc`, allowMissing: true } : undefined;
          if (to === 'project' && !directory) throw new Error(t('assistants.state.invalidConfiguration'));
          copyJournal = createCollectionJSONCCopy({ ...jsonc, directory, destination }, operation.request, operation.current);
        }
        const originalJSON = collectionJSONCEntry(snapshot.jsonc!.raw, 'command', snapshot.jsonc!.name).value;
        const merged = { ...snapshot.config, ...edits };
        const patch = Object.fromEntries(Object.entries(merged).filter(([key, value]) => key !== 'scope' && JSON.stringify(value) !== JSON.stringify(originalJSON[key])));
        const journal = copyJournal;
        writePending.set(true);
        try { await journal.save(name().trim(), patch); }
        finally { const phase = journal.phase(); writePending.set(phase !== 'draft' && phase !== 'done'); if (phase === 'draft') copyJournal = undefined; }
        if (!operation.current()) return;
        writePending.set(false);
      } else result = await operation.transaction(mutation.path, mutation.method, mutation.body);
      if (!(operation.current() && current())) return;
      committed.set(true);
      if (domain === 'plugins') original.set({ ...original(), ...draft(), ...(body.options ? { options: body.options } : {}) });
      invalidate();
      const success: I18nKey = domain === 'commands' ? 'settings.commands.page.toast.updated' : domain === 'skills.installed' ? 'settings.skills.page.toast.skillUpdated' : domain === 'plugins' ? 'settings.plugins.toast.updated' : domain === 'mcp' ? 'settings.mcp.page.toast.savedReloading' : 'settings.agents.page.toast.savedNextRequest';
      state.notice.set(t(result.requiresManualRestart ? 'settings.agents.page.toast.savedManualRestart' : result.reloadFailed ? 'settings.mcp.page.toast.savedReloadFailed' : success));
    }, operation);
  }
  async function changeDirectory(next: string | undefined) {
    const operation = state.operation(); if (!operation?.current() || state.busy() || writePending()) return;
    if (dirty()) {
      const answer = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' }] });
      if (!operation.current() || answer.action !== 'discard') return;
    }
    const route: SettingsCollectionRoute = { page: props.page, entity: props.entity, create: props.create, target: props.target, collectionDraft: props.collectionDraft, directory: next };
    if (props.onCollectionDirectory) props.onCollectionDirectory(next, route); else props.onOpen(route);
  }
  async function menu(item: Row) {
    if (!current() || state.busy() || !['agents', 'commands', 'skills.installed'].includes(domain)) return;
    const operation = state.operation(); if (!operation?.current()) return;
    const answer = await AlertDialog.show({ presentation: 'actionSheet', title: text(item.name), actions: [
      ...(!settingsSkillReadOnly(item) ? [{ id: 'rename', label: t('settings.common.actions.rename') }] : []),
      { id: 'copy', label: t('settings.common.actions.duplicate') },
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
    ] });
    if (!operation.current() || !['rename', 'copy'].includes(answer.action || '')) return;
    await state.perform(async lane => {
      const snapshot = await nativeCollectionDraft(lane.request, domain as 'agents' | 'commands' | 'skills.installed', item, directory);
      if (!lane.current()) return;
      if (answer.action === 'copy') {
        const route: SettingsCollectionRoute = { page: props.page, directory, create: true, collectionDraft: { ...snapshot, editor: { ...snapshot.editor, name: collectionCopyName(text(item.name), rows()) } } };
        props.onOpen(route);
      } else {
        if (snapshot.editor.isBuiltIn === true || settingsSkillReadOnly(item)) throw new Error(t('settings.agents.sidebar.toast.definitionNotFound'));
        const pending = renameJournals.get(text(item.name));
        renameSource = pending?.source || { item, snapshot }; renameOperation = pending?.operation || null; renameName.set(pending?.nextName || text(item.name)); renameRevision.set(renameRevision() + 1); renameOpen.set(true);
      }
    }, operation);
  }
  async function rename() {
    const operation = state.operation(); if (!operation?.current() || !renameSource) return;
    const source = renameSource;
    await state.perform(async lane => {
      if (!renameOperation) {
        const sanitized = renameName().trim().replace(/\s+/g, '-');
        const nextName = domain === 'skills.installed' ? sanitized.toLowerCase() : sanitized;
        if (domain === 'skills.installed' && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(nextName)) throw new Error(t('settings.skills.page.toast.invalidSkillName'));
        if (!nextName || rows().some(row => row.name === nextName)) throw new Error(t('settings.agents.sidebar.toast.agentExists'));
        renameOperation = createCollectionRename({ domain: domain as 'agents' | 'commands' | 'skills.installed', name: text(source.item.name), nextName, config: source.snapshot.config, scope: text(source.snapshot.editor.scope) || 'user', directory }, lane.request, lane.current);
        renameJournals.set(text(source.item.name), { operation: renameOperation, source, nextName });
      }
      try { await renameOperation.advance(); }
      finally { renameRevision.set(renameRevision() + 1); }
      if (!lane.current()) return;
      invalidate();
      if (renameOperation.phase() === 'done') { renameJournals.delete(text(source.item.name)); renameOpen.set(false); }
      else state.notice.set(t('settings.agents.sidebar.toast.removeOldAfterRenameFailed'));
    }, operation);
    if (operation.current() && renamePhase() === 'done') await load(operation);
  }
  const title = () => domain === 'mcp' ? t('settings.mcp.page.server.title') : domain === 'plugins' ? t('settings.plugins.page.header.entry') : domain === 'commands' ? t('settings.commands.page.section.identity') : t('settings.agents.page.section.identityRole');
  return <Scroll ref={ref => { scroll = ref; }} onScroll={navigation.onScroll} class="flex-1" contentClass="p-5 gap-5 pb-10" contentStyle={nativeDensity().pages.settings}>
    <SettingsFeedback state={state} retry={writePending() ? () => { void save(); } : !state.ready() ? () => { void load(); } : undefined} />
    <SettingsCollectionDirectory directory={directory} disabled={state.busy() || writePending()} current={current} onChange={next => { void changeDirectory(next); }} />
    <If when={!editing}>
      <If when={domain === 'agents'}><SettingsSavedPermissions directory={props.directory} /></If>
      <Button testID="settings-refresh" class={settingsAction} accessibilityLabel={t('sidebarFilesTree.actions.refreshTitle')} disabled={state.busy()} onPress={() => { void load(); }}><Icon name="refresh" /></Button>
      <Button class={settingsAction} onPress={() => props.onOpen({ page: props.page, directory, create: true })}><Text class="text-foreground">{t('settings.plugins.dialog.add.action.submit')}</Text></Button>
      <If when={domain === 'plugins'}><SettingsCollectionPlugins rows={rows()} directory={directory} current={current} onUpdated={invalidate} onOpen={item => props.onOpen({ page: props.page, directory, entity: text(item.id) || text(item.name) })} /></If>
      <If when={domain !== 'plugins'}><SettingsGroup title={title()}><Each of={rows()}>{item => <View class="gap-1"><Button class="min-h-12 py-3 gap-1 border-b border-border" onPress={() => props.onOpen({ page: props.page, directory, entity: text(item().id) || text(item().name) })}>
        <Text class="text-base text-foreground">{text(item().name) || text(item().spec) || text(item().filename) || text(item().id)}</Text><Text class="text-xs text-muted-foreground">{text(item().description) || text(item().scope)}</Text>
      </Button><If when={['agents', 'commands', 'skills.installed'].includes(domain)}><Button class={settingsAction} disabled={state.busy()} onPress={() => { void menu(item()); }} accessibilityLabel={text(item().name)}><Icon name="more" /></Button></If></View>}</Each><If when={state.ready() && !rows().length}><Text class="text-muted-foreground">{t('settings.plugins.page.empty.add')}</Text></If></SettingsGroup></If>
      <NativeSheet open={renameOpen()} closeOnSwipe={!state.busy()} closeOnBackdropPress={!state.busy()} closeOnEscape={!state.busy()} onOpenChange={event => renameOpen.set(event.open)} popupClass="bg-background"><Scroll class="flex-1" contentClass="p-5 gap-4" contentStyle={nativeDensity().pages.sheetSimple}><SettingsFeedback state={state} /><SettingsInput title={t('settings.common.actions.rename')} value={renameName()} disabled={state.busy() || (!!renamePhase() && renamePhase() !== 'draft')} onChange={next => renameName.set(next)} /><Button class={settingsAction} disabled={state.busy()} onPress={() => { void rename(); }}><Text class="text-foreground">{t('settings.common.actions.rename')}</Text></Button><Button class={settingsAction} disabled={state.busy()} onPress={() => renameOpen.set(false)}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button></Scroll></NativeSheet>
    </If>
    <If when={editing && state.ready()}>
      <SettingsGroup title={title()}>
        <If when={domain !== 'plugins' || !!original().file}><View ref={anchor(domain === 'mcp' ? 'mcp.server' : domain === 'skills.installed' ? 'skills.basic-information' : `${domain}.name`)} onLayout={() => reveal(domain === 'mcp' ? 'mcp.server' : domain === 'skills.installed' ? 'skills.basic-information' : `${domain}.name`)}><SettingsInput title={t(domain === 'commands' ? 'settings.commands.page.field.commandName' : domain === 'mcp' ? 'settings.mcp.page.server.name' : domain === 'skills.installed' ? 'settings.skills.page.field.skillNameLocation' : domain === 'plugins' ? 'settings.plugins.page.field.fileName' : 'settings.agents.page.field.agentName')} value={name()} disabled={!creating || locked()} onChange={next => { if (!locked()) name.set(next); }} /></View></If>
        <If when={creating || domain === 'agents'}><View ref={anchor('agents.scope')} onLayout={() => reveal('agents.scope')}>{choice('scope', 'settings.agents.page.field.scope', props.directory ? ['user', 'project'] : ['user'])}</View></If>
        <If when={domain !== 'plugins'}>{field('description', domain === 'commands' ? 'settings.commands.page.field.descriptionPlaceholder' : domain === 'skills.installed' ? 'settings.skills.page.field.descriptionPlaceholder' : 'settings.agents.page.field.descriptionPlaceholder')}</If>
        <If when={domain === 'agents'}>
          <View ref={anchor('agents.mode')} onLayout={() => reveal('agents.mode')}>{choice('mode', 'settings.agents.page.field.mode', ['primary', 'subagent', 'all'])}</View>
          <View ref={anchor('agents.model')} onLayout={() => reveal('agents.model')}><SettingsCollectionPicker value={value('model')} directory={directory} disabled={locked()} current={current} onChange={next => set('model', next)} /></View>
          {field('steps', 'settings.agents.page.field.steps')}
          <SettingsToggle title={t('settings.agents.page.field.hidden')} value={draft().hidden === true} disabled={state.busy() || committed()} onChange={next => set('hidden', next)} />
          <SettingsToggle title={t('settings.agents.page.field.disabled')} value={draft().disabled === true} disabled={state.busy() || committed()} onChange={next => set('disabled', next)} />
          {field('system', 'settings.agents.page.section.systemPrompt', true)}
          <View ref={anchor('agents.permissions')} onLayout={() => reveal('agents.permissions')}><SettingsPermissions rules={Array.isArray(draft().permissions) ? draft().permissions as Row[] : []} disabled={state.busy() || committed()} onChange={next => set('permissions', next)} /></View>
        </If>
        <If when={domain === 'commands'}><View ref={anchor('commands.agent')} onLayout={() => reveal('commands.agent')}><SettingsCollectionPicker agent value={value('agent')} directory={directory} disabled={locked()} current={current} onChange={next => set('agent', next)} /></View><View ref={anchor('commands.model')} onLayout={() => reveal('commands.model')}><SettingsCollectionPicker value={value('model')} directory={directory} disabled={locked()} current={current} onChange={next => set('model', next)} /></View>{field('template', 'settings.commands.page.section.template', true)}</If>
         <If when={domain === 'skills.installed'}>{field('instructions', 'settings.skills.page.section.instructions', true)}<View ref={anchor('skills.supporting-files')} onLayout={() => reveal('skills.supporting-files')}><SettingsSkillFiles name={name()} directory={props.directory} files={Array.isArray(draft().supportingFiles) ? draft().supportingFiles as Row[] : []} create={creating} readOnly={readOnly()} disabled={state.busy() || committed()} onDraft={next => set('supportingFiles', next)} /></View></If>
        <If when={domain === 'mcp'}>
          {choice('type', 'settings.mcp.page.server.transportMode', ['local', 'remote'])}
          <SettingsToggle title={t('settings.mcp.page.server.enable')} value={draft().enabled !== false} disabled={state.busy() || committed()} onChange={next => set('enabled', next)} />
            <If when={creating}><SettingsMcpImport name={name()} disabled={locked()} onOpenChange={next => importing.set(next)} onImport={(nextName, fields) => { if (locked()) return; name.set(nextName); draft.set({ ...draft(), ...fields }); changed.set({ ...changed(), ...fields }); state.notice.set(t('settings.mcp.page.toast.configImported')); }} /></If>
            <If when={draft().type === 'local'}><View ref={anchor('mcp.command')} onLayout={() => reveal('mcp.command')}><SettingsInput title={t('settings.mcp.page.connection.command')} disabled={locked()} multiline value={Array.isArray(draft().command) ? (draft().command as string[]).join('\n') : ''} onChange={next => set('command', next.split('\n').filter(line => line.length > 0))} /></View></If>
             <View ref={anchor('mcp.advanced')} onLayout={() => reveal('mcp.advanced')}><If when={draft().type === 'remote'}>
              <SettingsInput testID="settings-url" title={t('settings.mcp.page.connection.serverUrl')} value={value('url')} disabled={locked()} onChange={next => set('url', next)} />
              <SettingsInput testID="settings-timeout" title={t('settings.mcp.page.advanced.timeoutMs')} value={value('timeout')} disabled={locked()} onChange={next => set('timeout', next)} />
              <SettingsToggle title={t('settings.mcp.page.advanced.oauthAutoDetection')} value={draft().oauth !== false} disabled={locked()} onChange={next => set('oauth', next ? {} : false)} />
             <If when={draft().oauth !== false}><Each of={[
               ['clientId', 'settings.mcp.page.advanced.oauthClientIdPlaceholder'], ['clientSecret', 'settings.mcp.page.advanced.oauthClientSecretPlaceholder'], ['scope', 'settings.mcp.page.advanced.oauthScopesPlaceholder'], ['redirectUri', 'settings.mcp.page.advanced.oauthRedirectUriPlaceholder'],
             ] as const}>{pair => <SettingsInput testID={`mcp-oauth-${pair()[0]}`} title={t(pair()[1])} value={text(record(draft().oauth)[pair()[0]])} masked={pair()[0] === 'clientSecret'} disabled={locked()} onChange={next => { const oauth = { ...record(draft().oauth) }; if (next.trim()) oauth[pair()[0]] = next; else delete oauth[pair()[0]]; set('oauth', oauth); }} />}</Each></If>
            </If></View>
           <Each of={draft().type === 'remote' ? ['environment', 'headers'] : ['environment']}>{mapKey => <View ref={anchor(mapKey() === 'environment' ? 'mcp.environment' : 'mcp.headers')} onLayout={() => reveal(mapKey() === 'environment' ? 'mcp.environment' : 'mcp.headers')}><SettingsCollectionKV value={record(draft()[mapKey()])} headers={mapKey() === 'headers'} disabled={locked()} current={current} onChange={next => set(mapKey(), next)} /></View>}</Each>
        </If>
         <If when={domain === 'plugins' && !original().file}>{field('spec', 'settings.plugins.page.field.spec')}<SettingsInput title={t('settings.plugins.page.field.options')} disabled={locked()} multiline value={options()} onChange={next => options.set(next)} /></If>
        <If when={domain === 'plugins' && original().file}>{field('content', 'settings.plugins.page.field.content', true)}</If>
      </SettingsGroup>
       <If when={domain === 'plugins' && !creating}><SettingsPluginRuntime item={original()} directory={props.directory} disabled={state.busy() || (!committed() && (Object.keys(changes()).length > 0 || options() !== JSON.stringify(original().options || {}, null, 2)))} onBusy={busy => pluginBusy.set(busy)} onUpdated={spec => { if (spec) { original.set({ ...original(), spec }); draft.set({ ...draft(), spec }); } committed.set(true); invalidate(); }} /></If>
       <If when={domain === 'mcp' && !creating && !committed()}><SettingsMcpLive name={name()} directory={props.directory} disabled={state.busy() || Object.keys(changed()).length > 0} /></If>
        <If when={writePending()}><Text class="text-muted-foreground">{t(pendingPhase() === 'write-unknown' || pendingPhase() === 'unknown' ? 'settings.yuri.sessionRetention.result.uncertain' : 'settings.yuri.sessionRetention.result.ack')}</Text><Button class={settingsAction} disabled={state.busy() || !current()} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
        <If when={!committed() && !readOnly() && !writePending()}><Button class={settingsAction} disabled={locked() || importing() || (!creating && !Object.keys(changes()).length && (domain !== 'plugins' || options() === JSON.stringify(original().options || {}, null, 2)))} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button></If>
      <If when={committed()}><Button class={settingsAction} onPress={props.onBack}><Text class="text-foreground">{t('gitView.common.done')}</Text></Button></If>
       <If when={!creating && !committed() && !readOnly()}><Button class={settingsAction} disabled={locked()} onPress={() => { if (locked()) return; void state.perform(async (operation) => { if (readOnly()) return; const choice = await AlertDialog.show({ title: t('settings.mcp.page.deleteDialog.title', { name: name() }), actions: [{ id: 'cancel', label: t('settings.plugins.dialog.add.action.cancel'), role: 'cancel' }, { id: 'delete', label: t('mobile.instances.delete'), role: 'destructive' }] }); if (choice.action !== 'delete' || !(operation.current() && current())) return; const mutation = settingsMutation(domain, name(), {}, false, directory); const path = original().file ? scopedSettingsPath(`/api/config/plugins/file/${encodeURIComponent(name())}`, directory) : mutation.path; await operation.transaction(path, 'DELETE', domain === 'agents' ? { scope: draft().scope } : undefined); if (!(operation.current() && current())) return; invalidate(); props.onBack(); }); }}><Text class="text-destructive">{t('mobile.instances.delete')}</Text></Button></If>
    </If>
  </Scroll>;
}
