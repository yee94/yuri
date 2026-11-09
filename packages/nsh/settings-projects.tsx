import { effect, Scroll, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button, NavPage } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import { t } from './i18n';
import { Icon } from './Icon';
import { projectsFrom, record, text, type Row } from './model';
import { app } from './state';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsChoice, SettingsEntityLayout, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { readSettingsCollection, settingsObject, settingsRows } from './settings-protocol';
import { settingsProjectColors, settingsProjectIcons, settingsProjectPatch } from './settings-projects-core';
import { createProjectSettingsEditor, emptyProjectSettings, projectSettingsActionIcons, projectSettingsActionsValid, projectSettingsErrorKey, projectSettingsIdentityMatches, projectSettingsSetupEditable, type ProjectSettingsAction, type ProjectSettingsSection } from './project-settings';
import { publishSettingsNavigationOwner } from './desktop-settings-publisher';

const projectSettingsRevision = signal(0);

type ProjectsProps = SettingsCallbacks & SettingsRoute & { directory?: string };
export type ProjectSettingsNavigation = {
  blocked: boolean;
  pending: boolean;
  dirty: boolean;
  /** Only overlays owned here are observable. SettingsChoice's Select state
   * is not exposed yet; false must not be treated as complete picker coverage. */
  nestedPickerOpen: boolean;
  pickerCoverage: 'explicit-only';
  requestLeave: () => Promise<boolean>;
  back: () => void;
};

/** The route owner must use this page rather than wrapping the content in another NavPage. */
export function SettingsProjectsPage(props: ProjectsProps) {
  const navigation = signal<Pick<ProjectSettingsNavigation, 'blocked' | 'back'>>({ blocked: false, back: () => undefined });
  return <NavPage title={t('settings.page.projects.title')} headerBackTitle="" class="flex-1 bg-background" popOnBack={!navigation().blocked} popOnSwipe={!navigation().blocked} onBackPress={() => { if (navigation().blocked) navigation().back(); }}>
    <SettingsProjects {...props} onNavigation={next => navigation.set(next)} />
  </NavPage>;
}

export function SettingsProjects(props: ProjectsProps & { onNavigation?: (navigation: ProjectSettingsNavigation) => void }) {
  const state = settingsPageLifetime(), projects = signal<Row[]>([]), draft = signal<Row>({}), changes = signal<Row>({});

  const models = signal<{ value: string; title: string }[]>([]), modelError = signal(''), committed = signal(false);
  const auxiliary = signal(emptyProjectSettings()), confirming = signal(false), expanded = signal<Record<string, boolean>>({});
  const iconPicker = signal<string | null>(null);
  const identityReadback = signal(false), git = signal<boolean | null>(null), gitError = signal('');
  let editor: ReturnType<typeof createProjectSettingsEditor> | undefined;
  let expectedIdentity: Row | null = null;
  const editing = !!props.entity;
  const value = (key: string) => text(draft()[key]);
  const busy = () => state.busy() || !!auxiliary().busy || confirming();
  const disabled = () => busy() || !state.ready() || committed() || identityReadback() || !!auxiliary().pending;
  const auxiliaryDisabled = (section: ProjectSettingsSection) => busy() || !auxiliary().ready[section] || !!auxiliary().pending;
  const setupInputDisabled = () => confirming() || !projectSettingsSetupEditable(auxiliary());
  const dirty = () => { auxiliary(); return Object.keys(changes()).length > 0 || !!editor?.dirty('actions') || !!editor?.dirty('setup') || !!auxiliary().pending || identityReadback(); };
  const navigationPending = () => state.busy() || !!auxiliary().busy || !!auxiliary().pending || identityReadback();
  function update(key: string, next: unknown) {
    if (disabled()) return;
    draft.set({ ...draft(), [key]: next }); changes.set({ ...changes(), [key]: next });
  }
  async function loadModels(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    modelError.set('');
    try {
      const providers = await readSettingsCollection(operation.request, 'providers', value('path'));
      if (!operation.current()) return;
      models.set(providers.flatMap(provider => Object.entries(record(provider.models)).map(([id, model]) => ({ value: `${text(provider.id)}/${id}`, title: `${text(provider.name) || text(provider.id)} / ${text(record(model).name) || id}` }))));
    } catch { if (operation.current()) modelError.set(t('common.unavailable')); }
  }
  async function loadRepository(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    gitError.set('');
    try {
      const result = settingsObject(await operation.request(`/api/git/check?directory=${encodeURIComponent(value('path'))}`));
      if (typeof result.isGitRepository !== 'boolean') throw new Error(t('common.unavailable'));
      if (operation.current()) git.set(result.isGitRepository);
    } catch (error) { if (operation.current()) gitError.set(error instanceof Error ? error.message : t('common.unavailable')); }
  }
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      const result = settingsObject(await operation.request('/api/config/settings'));
      const rows = settingsRows(result.projects);
      if (!operation.current()) return;
      projects.set(rows);
      if (editing) {
        const selected = rows.find(project => project.id === props.entity);
        if (!selected) throw new Error(t('common.unavailable'));
        if (!state.ready()) draft.set(selected);
        if (!editor) {
          editor = createProjectSettingsEditor(operation.request, operation.current, { id: text(selected.id), path: text(selected.path) }, next => auxiliary.set(next));
          void editor.load(); void loadModels(operation); void loadRepository(operation);
        }
      }
      state.ready.set(true);
    }, operation);
  }
  void load();
  state.observeOperation(operation => {
    confirming.set(false); editor?.replaceLane(operation);
    if (operation) { if (editor) void editor.resume(); void load(operation); if (editor) { void loadModels(operation); void loadRepository(operation); } }
  });
  let seenRevision = projectSettingsRevision();
  effect(() => {
    const revision = projectSettingsRevision();
    if (revision === seenRevision) return;
    seenRevision = revision;
    if (!editing) untracked(() => { if (state.current()) void load(); });
  });
  async function requestLeave(operation: SettingsOperation | null = state.operation()): Promise<boolean> {
    if (!operation?.current() || confirming() || navigationPending() || iconPicker()) return false;
    if (!dirty()) return true;
    confirming.set(true);
    let approved = false;
    try {
      const answer = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [
        { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
        { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
      ] });
      approved = operation.current() && answer.action === 'discard' && !state.busy() && !auxiliary().busy && !auxiliary().pending && !identityReadback() && !iconPicker();
    } finally { if (operation.current()) confirming.set(false); }
    return approved;
  }
  async function back(operation: SettingsOperation | null = state.operation()) {
    if (await requestLeave(operation) && operation?.current()) props.onBack();
  }
  publishSettingsNavigationOwner({ dirty, pending: navigationPending, nestedPickerOpen: () => !!iconPicker(), requestLeave, stamp: () => [changes(), auxiliary(), state.operation()], scope: state.operation });
  effect(() => { props.onNavigation?.({ blocked: busy() || navigationPending() || dirty() || !!iconPicker(), pending: navigationPending(), dirty: dirty(), nestedPickerOpen: !!iconPicker(), pickerCoverage: 'explicit-only', requestLeave, back: () => { void back(); } }); });
  for (const section of ['actions', 'setup'] as const) effect(() => {
    const operation = state.operation();
    const snapshot = auxiliary();
    if (!editor || !snapshot.ready[section] || snapshot.busy || snapshot.pending || snapshot.errors[section] || state.busy() || confirming() || git() !== true && section === 'setup') return;
    if (!operation?.current() || !editor.autoSaveAllowed(section) || !editor.dirty(section) || section === 'actions' && !projectSettingsActionsValid(snapshot.actions)) return;
    const timer = setTimeout(() => { if (operation.current()) void editor?.save(section); }, 450);
    return () => clearTimeout(timer);
  });
  async function readIdentity(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    const fresh = settingsObject(await operation.request('/api/config/settings'));
    const selected = settingsRows(fresh.projects).find(project => project.id === props.entity);
    if (!selected) throw new Error(t('common.unavailable'));
    if (expectedIdentity && !projectSettingsIdentityMatches(selected, expectedIdentity, Object.keys(changes()))) throw new Error(t('common.unavailable'));
    if (!operation.current()) return;
    draft.set(selected); app.projects.set(projectsFrom(fresh));
    identityReadback.set(false); committed.set(true); changes.set({});
    projectSettingsRevision.set(projectSettingsRevision() + 1);
    state.notice.set(t('filesView.editor.saved'));
  }
  async function save(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (busy() || !state.ready() || !Object.keys(changes()).length && !identityReadback()) return;
    await state.perform(async (operation) => {
      if (identityReadback()) { await readIdentity(operation); return; }
      const fresh = settingsObject(await operation.request('/api/config/settings'));
      if (!operation.current()) return;
      let patch: { projects: Row[] };
      try { patch = settingsProjectPatch(fresh, props.entity || '', changes()); }
      catch { throw new Error(t('assistants.state.invalidConfiguration')); }
      expectedIdentity = patch.projects.find(project => project.id === props.entity) || null;
      await operation.transaction('/api/config/settings', 'PUT', patch);
      if (!operation.current()) return;
      identityReadback.set(true);
      await readIdentity(operation);
    }, operation);
  }
  function actionUpdate(id: string, patch: Partial<ProjectSettingsAction>) {
    editor?.edit('actions', { actions: auxiliary().actions.map(action => action.id === id ? { ...action, ...patch } : action) });
  }
  function addAction() {
    if (auxiliaryDisabled('actions')) return;
    const id = `nsh-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    editor?.edit('actions', { actions: [...auxiliary().actions, { id, name: '', command: '', icon: 'play' }] });
    expanded.set({ ...expanded(), [id]: true });
  }
  async function reloadSection(section: ProjectSettingsSection, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (busy()) return;
    if (editor?.dirty(section) || auxiliary().pending === section) {
      confirming.set(true);
      try {
        const answer = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [
          { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
          { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
        ] });
        if (!operation.current() || answer.action !== 'discard') return;
      } finally { if (operation.current()) confirming.set(false); }
    }
    void editor?.reload(section);
  }
  function sectionFeedback(section: ProjectSettingsSection) {
    return <View class="gap-2">
      <If when={!!auxiliary().errors[section]}><Text class="text-sm text-destructive">{t(projectSettingsErrorKey(section))}</Text><If when={auxiliary().errors[section].startsWith('HTTP ')}><Text class="text-xs text-destructive">{auxiliary().errors[section]}</Text></If></If>
      <If when={!!auxiliary().errors[section] && !auxiliary().busy}><Button testID={`project-${section}-reload`} class={settingsAction} onPress={() => { void reloadSection(section); }}><Text class="text-foreground">{t('sidebarFilesTree.actions.refreshTitle')}</Text></Button></If>
      <If when={auxiliary().saved === section}><Text class="text-xs text-muted-foreground">{t(section === 'actions' ? 'settings.projects.actions.toast.saved' : 'filesView.editor.saved')}</Text></If>
      <If when={auxiliary().ready[section] && (editor?.dirty(section) || auxiliary().pending === section)}><Button testID={`project-${section}-save`} class={settingsAction} disabled={busy() || !!auxiliary().pending && auxiliary().pending !== section || section === 'actions' && !projectSettingsActionsValid(auxiliary().actions)} onPress={() => { void editor?.save(section); }}><Text class="text-foreground">{t(auxiliary().pending === section ? 'settings.voice.volcengine.retry' : section === 'actions' ? 'settings.projects.actions.actions.save' : 'settings.common.actions.saveChanges')}</Text></Button></If>
    </View>;
  }
  const none = () => ({ value: '', title: t('settings.projects.page.field.none') });
  const modelOptions = () => [none(), ...models(), ...(value('defaultModel') && !models().some(item => item.value === value('defaultModel')) ? [{ value: value('defaultModel'), title: value('defaultModel') }] : [])];
  const projectList = () => <Scroll class="flex-1 min-w-0 min-h-0" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
      <Button testID="settings-project-refresh" class={settingsAction} disabled={state.busy()} accessibilityLabel={t('sidebarFilesTree.actions.refreshTitle')} onPress={() => { void load(); }}><Icon name="refresh" /></Button>
      <SettingsGroup title={t('settings.page.projects.title')}><Each of={projects()}>{project => <Button testID={`settings-entity-${text(project().id)}`} selected={props.entity === text(project().id)} disabled={!state.current() || busy()} class="min-h-12 py-3 gap-1 selected:bg-accent" onPress={() => { if (state.current()) props.onOpen({ page: 'projects', entity: text(project().id) }); }}><Text class="text-base text-foreground">{text(project().label) || text(project().name) || text(project().path)}</Text><Text class="text-xs text-muted-foreground">{text(project().path)}</Text></Button>}</Each><If when={state.ready() && !projects().length}><Text class="text-muted-foreground">{t('settings.projects.page.empty.noProjects')}</Text></If></SettingsGroup>
  </Scroll>;
  return <SettingsEntityLayout editing={editing} list={projectList}><Scroll class="flex-1 min-w-0 min-h-0" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
    <If when={editing && state.ready()}>
      <Text class="text-sm text-muted-foreground">{value('path')}</Text>
      <SettingsGroup title={t('settings.page.projects.title')}>
        <SettingsInput testID="settings-project-label" title={t('settings.projects.page.field.projectName')} value={value('label')} disabled={disabled()} onChange={next => update('label', next)} />
        <SettingsChoice title={t('settings.projects.page.field.defaultModel')} value={value('defaultModel')} items={modelOptions()} disabled={disabled()} onChange={next => update('defaultModel', next || null)} />
        <If when={!!modelError()}><Text class="text-sm text-destructive">{modelError()}</Text><Button class={settingsAction} disabled={state.busy()} onPress={() => { void loadModels(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
        <Text class="text-sm text-foreground">{t('settings.projects.page.field.projectIcon')}</Text>
        <View class="flex-row flex-wrap gap-2"><Button class="min-h-11 min-w-11 rounded-xl bg-secondary items-center justify-center" disabled={disabled()} accessibilityLabel={t('settings.projects.page.field.none')} onPress={() => update('icon', null)}><Icon name="close" /></Button><Each of={Object.entries(settingsProjectIcons)}>{pair => <Button class={'min-h-11 min-w-11 rounded-xl items-center justify-center ' + (value('icon') === pair()[0] ? 'bg-accent' : 'bg-secondary')} disabled={disabled()} accessibilityLabel={t('settings.projects.actions.field.iconAria', { icon: pair()[0] })} onPress={() => update('icon', pair()[0])}><Icon name={pair()[1]} /></Button>}</Each></View>
        <SettingsChoice title={t('settings.projects.page.field.accentColor')} value={value('color')} items={[none(), ...settingsProjectColors.map(color => ({ value: color, title: color }))]} disabled={disabled()} onChange={next => update('color', next || null)} />
        <SettingsInput title={t('settings.projects.page.field.projectIconBackgroundAria')} value={value('iconBackground')} disabled={disabled()} onChange={next => update('iconBackground', next.trim() || null)} />
      </SettingsGroup>
      <If when={!committed()}><Button testID="settings-project-save" class={settingsAction} disabled={busy() || !Object.keys(changes()).length && !identityReadback()} onPress={() => { void save(); }}><Text class="text-foreground">{t(identityReadback() ? 'settings.voice.volcengine.retry' : 'settings.plugins.page.action.save')}</Text></Button></If>
      <SettingsGroup title={t('settings.projects.actions.title')}>
        <Text class="text-sm text-muted-foreground">{t('settings.projects.actions.description')}</Text>
        <Button testID="project-action-add" class={settingsAction} disabled={auxiliaryDisabled('actions')} onPress={addAction}><Text class="text-foreground">{t('settings.projects.actions.actions.add')}</Text></Button>
        <If when={!auxiliary().ready.actions && auxiliary().busy === 'load'}><Text class="text-muted-foreground">{t('settings.projects.actions.state.loading')}</Text></If>
        <If when={auxiliary().ready.actions && !auxiliary().actions.length}><Text class="text-muted-foreground">{t('settings.projects.actions.state.empty')}</Text></If>
        <Each of={auxiliary().actions}>{action => <View class="gap-3">
          <View class="flex-row items-center gap-2"><Button testID={`project-action-expand-${action().id}`} class="min-h-11 flex-1 flex-row gap-2 items-center" onPress={() => expanded.set({ ...expanded(), [action().id]: !expanded()[action().id] })}><Icon name={expanded()[action().id] ? 'arrow-down-s' : 'arrow-right-s'} /><Icon name={projectSettingsActionIcons.find(icon => icon.key === action().icon)?.Icon || 'play'} /><Text class="flex-1 text-foreground">{action().name.trim() || t('settings.projects.actions.state.untitled')}</Text></Button>
            <Button testID={`project-action-delete-${action().id}`} class="min-h-11 min-w-11 items-center justify-center" disabled={auxiliaryDisabled('actions')} accessibilityLabel={t('settings.common.actions.delete')} onPress={() => editor?.edit('actions', { actions: auxiliary().actions.filter(item => item.id !== action().id) })}><Icon name="delete-bin" /></Button></View>
          <If when={!!expanded()[action().id]}><View class="gap-3">
            <SettingsInput testID={`project-action-name-${action().id}`} title={t('settings.projects.actions.field.actionNamePlaceholder')} value={action().name} disabled={auxiliaryDisabled('actions')} onChange={name => actionUpdate(action().id, { name })} />
            <Button testID={`project-action-icon-picker-${action().id}`} class={settingsAction + ' flex-row gap-2'} disabled={auxiliaryDisabled('actions')} onPress={() => iconPicker.set(action().id)}><Icon name={projectSettingsActionIcons.find(icon => icon.key === action().icon)?.Icon || 'play'} /><Text class="text-foreground">{t('settings.projects.actions.field.selectIconAria')}</Text></Button>
            <SettingsInput testID={`project-action-command-${action().id}`} title={t('settings.projects.actions.field.command')} value={action().command} multiline disabled={auxiliaryDisabled('actions')} onChange={command => actionUpdate(action().id, { command })} />
            <SettingsToggle testID={`project-action-url-toggle-${action().id}`} title={t('settings.projects.actions.field.autoOpenUrl')} value={action().autoOpenUrl === true} disabled={auxiliaryDisabled('actions')} onChange={autoOpenUrl => actionUpdate(action().id, { autoOpenUrl })} />
            <Text class="text-xs text-muted-foreground">{t('settings.projects.actions.field.autoOpenUrlDescription')}</Text>
            <If when={action().autoOpenUrl === true}><SettingsInput testID={`project-action-url-${action().id}`} title={t('settings.projects.actions.field.overrideUrlPlaceholder')} value={action().openUrl || ''} disabled={auxiliaryDisabled('actions')} onChange={openUrl => actionUpdate(action().id, { openUrl })} /><Text class="text-xs text-muted-foreground">{t('settings.projects.actions.field.overrideUrlTooltip')}</Text></If>
          </View></If>
        </View>}</Each>
        <If when={!projectSettingsActionsValid(auxiliary().actions)}><Text class="text-sm text-destructive">{t('settings.projects.actions.validation.fillNameAndCommand')}</Text></If>
        {sectionFeedback('actions')}
      </SettingsGroup>
      <SettingsGroup title={t('settings.projects.page.section.worktree')}>
        <If when={!!gitError()}><Text class="text-sm text-destructive">{gitError()}</Text><Button class={settingsAction} disabled={busy()} onPress={() => { void loadRepository(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
        <If when={git() === false}><Text class="text-muted-foreground">{t('settings.yuri.worktrees.state.gitOnly')}</Text></If>
        <If when={git() === null && !gitError()}><Text class="text-muted-foreground">{t('settings.yuri.worktrees.setup.loading')}</Text></If>
        <If when={git() === true}>
          <Text class="text-xs text-muted-foreground">{t('settings.yuri.worktrees.setup.tooltipPrefix')} $ROOT_PROJECT_PATH {t('settings.yuri.worktrees.setup.tooltipSuffix')}</Text>
          <Each of={auxiliary().commandIDs} key={id => id}>{(commandID, index) => <View class="gap-2"><SettingsInput testID={`project-setup-command-${index()}`} title={t('settings.yuri.worktrees.setup.title')} value={auxiliary().commands[index()]} disabled={setupInputDisabled()} onChange={next => editor?.updateCommand(commandID(), next)} /><Button testID={`project-setup-delete-${index()}`} class={settingsAction} disabled={auxiliaryDisabled('setup')} accessibilityLabel={t('settings.yuri.worktrees.setup.removeCommandAria')} onPress={() => editor?.removeCommand(commandID())}><Icon name="close" /></Button></View>}</Each>
          <Button testID="project-setup-add" class={settingsAction} disabled={auxiliaryDisabled('setup')} onPress={() => editor?.appendCommand()}><Text class="text-foreground">{t('settings.yuri.worktrees.setup.addCommand')}</Text></Button>
          <SettingsToggle testID="project-setup-wait" title={t('settings.yuri.worktrees.setup.waitForCommands')} value={auxiliary().wait} disabled={auxiliaryDisabled('setup')} onChange={wait => { editor?.edit('setup', { wait }); void editor?.save('setup'); }} />
          {sectionFeedback('setup')}
        </If>
      </SettingsGroup>
      <Button testID={committed() ? 'settings-project-done' : 'project-settings-back'} class={settingsAction} disabled={busy()} onPress={() => { void back(); }}><Text class="text-foreground">{t('gitView.common.done')}</Text></Button>
      <Sheet open={!!iconPicker()} onOpenChange={event => { if (!event.open) iconPicker.set(null); }} popupClass="bg-card rounded-t-3xl p-5 gap-3">
        <If when={!!iconPicker()}><Text class="text-base text-foreground">{t('settings.projects.actions.field.selectIconAria')}</Text><View class="flex-row flex-wrap gap-2"><Each of={projectSettingsActionIcons}>{icon => <Button testID={`project-action-icon-${icon().key}`} class={'min-h-11 min-w-11 items-center justify-center rounded-xl ' + ((auxiliary().actions.find(action => action.id === iconPicker())?.icon || 'play') === icon().key ? 'bg-accent' : 'bg-secondary')} disabled={auxiliaryDisabled('actions')} accessibilityLabel={t('settings.projects.actions.field.iconAria', { icon: icon().key })} onPress={() => { const id = iconPicker(); if (id) actionUpdate(id, { icon: icon().key }); iconPicker.set(null); }}><Icon name={icon().Icon} /></Button>}</Each></View><Button class={settingsAction} onPress={() => iconPicker.set(null)}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button></If>
      </Sheet>
    </If>
  </Scroll></SettingsEntityLayout>;
}
