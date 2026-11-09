import { cleanup, effect, keymap, lifecycle, Scroll, signal, Text, View, type ScrollRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { t } from './i18n';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { SettingsTarget } from './settings-target';
import { createSettingsTargetNavigation } from './settings-search-core';
import { publishSettingsEditor, publishSettingsPicker } from './desktop-settings-publisher';
import { bindRawRequest } from './runtime';
import { text, type Row } from './model';
import { scopedSettingsPath, settingsObject, settingsRows } from './settings-protocol';
import { mergeNativeCatalogItems, nativeCatalogFailure, nativeCatalogPage, nativeCatalogSourcePath, nativeCatalogSources, nativeSkillCatalogPatch, nativeSkillInstall, type NativeCatalogSkill, type NativeCatalogSource, type NativeSkillConflict } from './settings-skills-catalog-core';

export function SettingsSkillsCatalog(props: SettingsCallbacks & SettingsRoute & { active?: boolean }) {
  const state = settingsPageLifetime(() => props.active !== false && lifecycle() === 'active');
  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, state.current);
  const sources = signal<NativeCatalogSource[] | null>(null), selected = signal(''), items = signal<NativeCatalogSkill[] | null>(null), cursor = signal<string | null>(null), search = signal('');
  const panel = signal<'add' | 'install' | null>(null), panelOpen = signal(false), panelVisible = signal(false), confirming = signal(false);
  const add = signal({ id: '', label: '', source: '', subpath: '', gitIdentityId: '' }), scanStamp = signal(''), scanCount = signal<number | null>(null), addCommitted = signal(false);
  const identities = signal<{ id: string; name: string }[]>([]), installItem = signal<NativeCatalogSkill | null>(null), location = signal('user-opencode'), directory = signal(props.directory ?? '');
  const projects = signal<Row[] | null>(null), projectError = signal(false), installIdentity = signal(''), installBaseline = signal(''), installUnknown = signal(false), conflicts = signal<NativeSkillConflict[]>([]), decisions = signal<Record<string, 'skip' | 'overwrite'>>({}), installAttempted = signal(false), installCommitted = signal(false);
  const receipt = signal<ReturnType<typeof nativeSkillInstall> | null>(null), installed = signal<string[]>([]), skipped = signal<string[]>([]);
  const scanIdentity = () => JSON.stringify([add().source.trim(), add().subpath.trim(), add().gitIdentityId]);
  const draftDirty = () => panelOpen() && (panel() === 'add' ? !addCommitted() && !!(add().label || add().source || add().subpath || add().gitIdentityId) : !installCommitted() && (installAttempted() || location() !== 'user-opencode' || directory() !== (props.directory ?? '') || installIdentity() !== installBaseline()));
  const owner = publishSettingsEditor({ current: state.current, scope: state.operation, pending: () => state.busy() || confirming(), dirty: draftDirty, stamp: () => [add(), location(), directory(), installIdentity(), conflicts(), decisions()] });
  publishSettingsPicker(() => panelOpen() || panelVisible());
  effect(() => { if (panelOpen() && props.active !== false && state.current() && !state.busy()) cleanup(keymap.bind('escape', () => { void closePanel(); }, { when: 'always' })); });
  const disabled = () => state.busy() || confirming() || !state.current();
  async function raw(operation: SettingsOperation, path: string, body: unknown) {
    if (!operation.current() || !operation.scope) throw new Error(t('common.unavailable'));
    const result = await bindRawRequest(operation.scope)(path, 'POST', body);
    if (!operation.current()) throw new Error(t('common.unavailable'));
    return result;
  }
  async function loadSource(operation: SettingsOperation, options: { refresh?: boolean; more?: boolean } = {}) {
    if (!operation.current() || !selected()) return;
    const source = selected(), previousCursor = cursor();
    if (options.more && !previousCursor) return;
    const page = nativeCatalogPage(await operation.request(nativeCatalogSourcePath(source, props.directory, { refresh: options.refresh, cursor: options.more ? previousCursor : null })), source);
    if (!operation.current() || selected() !== source) return;
    if (options.more && page.cursor === previousCursor) throw new Error(t('settings.skills.catalog.page.error.catalogTitle'));
    items.set(options.more ? mergeNativeCatalogItems(items() ?? [], page.items) : page.items); cursor.set(page.cursor);
  }
  async function loadSources(operation: SettingsOperation) {
    const next = nativeCatalogSources(await operation.request(scopedSettingsPath('/api/config/skills/catalog', props.directory)));
    if (!operation.current()) return;
    sources.set(next); state.ready.set(true);
    if (!next.some(source => source.id === selected())) { selected.set(next[0]?.id ?? ''); items.set(null); cursor.set(null); }
    if (selected()) await loadSource(operation);
  }
  const refresh = () => state.perform(operation => sources() ? loadSource(operation, { refresh: true }) : loadSources(operation));
  void state.perform(loadSources);
  state.observeOperation(operation => { scanStamp.set(''); if (operation) void state.perform(loadSources, operation); });
  async function closePanel() { if (await owner.requestLeave()) panelOpen.set(false); }
  function changeAdd(key: 'label' | 'source' | 'subpath' | 'gitIdentityId', value: string) {
    if (disabled() || addCommitted()) return;
    add.set({ ...add(), [key]: value });
    if (key !== 'label') { scanStamp.set(''); scanCount.set(null); }
    if (key === 'source') { identities.set([]); add.set({ ...add(), gitIdentityId: '' }); }
  }
  async function scan() {
    await state.perform(async operation => {
      const captured = scanIdentity(); scanStamp.set(''); scanCount.set(null);
      if (!add().source.trim()) throw new Error(t('settings.skills.catalog.add.toast.repositoryRequired'));
      const response = await raw(operation, '/api/config/skills/scan', { source: add().source.trim(), ...(add().subpath.trim() ? { subpath: add().subpath.trim() } : {}), ...(add().gitIdentityId ? { gitIdentityId: add().gitIdentityId } : {}) });
      const failure = nativeCatalogFailure(response);
      if (failure) { identities.set(failure.identities); throw new Error(t(failure.kind === 'authRequired' ? 'settings.skills.catalog.add.toast.authenticationRequiredScan' : 'settings.skills.catalog.add.toast.scanFailed')); }
      const found = settingsRows(settingsObject(response.body).items);
      if (scanIdentity() !== captured) return;
      scanCount.set(found.length);
      if (!found.length) throw new Error(t('settings.skills.catalog.add.toast.noSkillsFound'));
      scanStamp.set(captured); state.notice.set(t('settings.skills.catalog.shared.toast.foundSkills', { count: found.length }));
    });
  }
  async function saveCatalog() {
    let completed = false;
    await state.perform(async operation => {
      const draft = add();
      if (!draft.label.trim() || !draft.source.trim()) throw new Error(t('settings.skills.catalog.add.toast.catalogNameRequired'));
      if (!addCommitted() && scanStamp() !== scanIdentity()) throw new Error(t('settings.skills.catalog.add.toast.scanBeforeAdd'));
      const before = settingsObject(await operation.request('/api/config/settings'));
      const entry = { id: draft.id, label: draft.label.trim(), source: draft.source.trim(), ...(draft.subpath.trim() ? { subpath: draft.subpath.trim() } : {}), ...(draft.gitIdentityId ? { gitIdentityId: draft.gitIdentityId } : {}) };
      const patch = nativeSkillCatalogPatch(before, { add: entry });
      if (!settingsRows(before.skillCatalogs ?? []).some(row => row.id === entry.id)) await operation.transaction('/api/config/settings', 'PUT', patch);
      if (!operation.current()) return;
      addCommitted.set(true); selected.set(entry.id); items.set(null); cursor.set(null);
      await loadSources(operation); state.notice.set(t('settings.skills.catalog.add.toast.catalogAdded')); completed = true;
    });
    if (completed && state.current()) panelOpen.set(false);
  }
  async function removeSource() {
    const operation = state.operation(), id = selected();
    if (disabled() || !id.startsWith('custom:') || !operation) return;
    confirming.set(true);
    let answer: Awaited<ReturnType<typeof AlertDialog.show>>;
    try { answer = await AlertDialog.show({ title: t('settings.skills.catalog.page.actions.removeCatalogTitle'), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'remove', label: t('settings.skills.catalog.page.actions.removeCatalogTitle'), role: 'destructive' }] }); }
    finally { confirming.set(false); }
    if (answer.action !== 'remove' || !operation.current() || selected() !== id) return;
    await state.perform(async operation => {
      const before = await operation.request('/api/config/settings');
      await operation.transaction('/api/config/settings', 'PUT', nativeSkillCatalogPatch(before, { remove: id }));
      await loadSources(operation);
    }, operation);
  }
  async function openInstall(item: NativeCatalogSkill) {
    if (disabled() || !item.installable) return;
    installItem.set(item); location.set('user-opencode'); directory.set(props.directory ?? ''); installIdentity.set(item.gitIdentityId ?? ''); installBaseline.set(item.gitIdentityId ?? ''); installUnknown.set(false); identities.set([]); conflicts.set([]); decisions.set({}); receipt.set(null); installAttempted.set(false); installCommitted.set(false); installed.set([]); skipped.set([]); panel.set('install'); panelOpen.set(true);
    await state.perform(loadProjects);
  }
  async function loadProjects(operation: SettingsOperation) {
    projectError.set(false);
    try { const result = settingsObject(await operation.request('/api/config/settings')); if (operation.current()) projects.set(settingsRows(result.projects ?? []).filter(row => typeof row.path === 'string' && !!row.path)); }
    catch { if (operation.current()) { projectError.set(true); throw new Error(t('settings.skills.catalog.installSkill.toast.installFailed')); } }
  }
  async function install() {
    let completed = false;
    await state.perform(async operation => {
      const item = installItem(); if (!item || installCommitted() || installUnknown()) return;
      if (location().startsWith('project-') && (projectError() || !projects()?.some(project => project.path === directory()))) throw new Error(t('settings.skills.catalog.installSkill.toast.installFailed'));
      let request = conflicts().length ? receipt() : nativeSkillInstall({ ...item, ...(installIdentity() ? { gitIdentityId: installIdentity() } : {}) }, location(), directory());
      if (!request) throw new Error(t('common.unavailable'));
      if (conflicts().length) request = { path: request.path, body: { ...request.body, conflictDecisions: decisions() } };
      receipt.set(request); installAttempted.set(true);
      installUnknown.set(true);
      const response = await raw(operation, request.path, request.body), failure = nativeCatalogFailure(response);
      if (failure) {
        identities.set(failure.identities);
        if (response.status === 401 && failure.kind === 'authRequired' || response.status === 409 && failure.kind === 'conflicts') installUnknown.set(false);
        if (response.status === 409 && failure.kind === 'conflicts' && failure.conflicts.length) { conflicts.set(failure.conflicts); decisions.set(Object.fromEntries(failure.conflicts.map(conflict => [conflict.skillName, 'skip']))); return; }
        throw new Error(t(failure.kind === 'authRequired' ? 'settings.skills.catalog.installSkill.toast.authRequired' : 'settings.skills.catalog.installSkill.toast.installFailed'));
      }
      const result = settingsObject(response.body);
      const installedNames = settingsRows(result.installed).map(row => { if (typeof row.skillName !== 'string') throw new Error(t('common.unavailable')); return row.skillName; });
      const skippedNames = settingsRows(result.skipped).map(row => { if (typeof row.skillName !== 'string' || typeof row.reason !== 'string') throw new Error(t('common.unavailable')); return `${row.skillName}: ${row.reason}`; });
      installed.set(installedNames); skipped.set(skippedNames); installCommitted.set(true); installUnknown.set(false); conflicts.set([]);
      state.notice.set(t('settings.skills.catalog.installSkill.toast.installed'));
      await loadSource(operation, { refresh: true }); completed = skippedNames.length === 0;
    });
    if (installUnknown() && state.current()) state.error.set(t('settings.common.writeUnconfirmed'));
    if (completed && state.current()) panelOpen.set(false);
  }
  const filtered = () => (items() ?? []).filter(item => `${item.skillName} ${item.frontmatterName ?? ''} ${item.description ?? ''}`.toLocaleLowerCase().includes(search().trim().toLocaleLowerCase()));
  return <Scroll ref={scroll} onScroll={event => navigation.onScroll(event)} class="flex-1" contentClass="p-5 gap-5 pb-10">
    <SettingsFeedback state={state} retry={() => { void refresh(); }} />
    <SettingsTarget id="skills.catalog.source" target={props.target} onReveal={node => { void navigation.reveal(node); }}><SettingsGroup title={t('settings.skills.catalog.page.section.sourceRepository')}>
      <SettingsChoice testID="skills-catalog-source" title={t('settings.skills.catalog.page.section.sourceRepository')} value={selected()} items={(sources() ?? []).map(source => ({ value: source.id, title: source.label }))} disabled={disabled() || !sources()?.length} onChange={value => {
        if (disabled() || !sources()?.some(source => source.id === value)) return;
        selected.set(value); items.set(null); cursor.set(null); void state.perform(operation => loadSource(operation));
      }} />
      <View class="flex-row flex-wrap gap-2"><Button testID="skills-catalog-refresh" class={settingsAction} disabled={disabled()} onPress={() => { void refresh(); }}><Text>{t('settings.skills.catalog.page.actions.refreshTitle')}</Text></Button>
        <Button testID="skills-catalog-add" class={settingsAction} disabled={disabled()} onPress={() => { add.set({ id: `custom:${Date.now()}-${Math.random().toString(16).slice(2)}`, label: '', source: '', subpath: '', gitIdentityId: '' }); scanStamp.set(''); scanCount.set(null); addCommitted.set(false); identities.set([]); panel.set('add'); panelOpen.set(true); }}><Text>{t('settings.skills.catalog.page.actions.addCatalog')}</Text></Button>
        <If when={selected().startsWith('custom:')}><Button testID="skills-catalog-remove" class={settingsAction} disabled={disabled()} onPress={() => { void removeSource(); }}><Text class="text-destructive">{t('settings.skills.catalog.page.actions.removeCatalogTitle')}</Text></Button></If>
        <Button testID="skills-catalog-installed" class={settingsAction} disabled={disabled()} onPress={() => props.onOpen({ page: 'skills.installed', directory: props.directory })}><Text>{t('settings.skills.catalog.page.mode.manual')}</Text></Button></View>
    </SettingsGroup></SettingsTarget>
    <SettingsTarget id="skills.catalog.search" target={props.target} onReveal={node => { void navigation.reveal(node); }}><SettingsInput testID="skills-catalog-search" title={t('settings.skills.catalog.shared.field.searchSkillsPlaceholder')} value={search()} onChange={value => search.set(value)} /></SettingsTarget>
    <If when={items() !== null}><Text class="text-xs text-muted-foreground">{t('settings.skills.catalog.page.foundCount', { count: filtered().length })}</Text>
      <If when={!filtered().length}><Text class="text-sm text-muted-foreground">{t('settings.skills.catalog.page.empty.noSkillsTitle')}</Text></If>
      <Each of={filtered()}>{item => <SettingsGroup title={item().skillName}>
        <Text class="text-sm text-muted-foreground">{item().description || t('settings.skills.catalog.shared.noDescription')}</Text>
        <If when={item().installed?.isInstalled}><Text class="text-xs text-muted-foreground">{t('settings.skills.catalog.page.badge.installed', { scope: item().installed?.scope || t('settings.skills.catalog.page.badge.unknown') })}</Text></If>
        <If when={!!item().clawdhub}><Text class="text-xs text-muted-foreground">{item().clawdhub?.owner} · {item().clawdhub?.version} · {item().clawdhub?.downloads ?? 0} · {item().clawdhub?.stars ?? 0}</Text></If>
        <Each of={item().warnings ?? []}>{warning => <Text class="text-xs text-muted-foreground">{warning()}</Text>}</Each>
        <If when={!item().installable}><Text class="text-xs text-muted-foreground">{t('settings.skills.catalog.page.badge.notInstallable')}</Text></If>
        <Button testID={`skills-catalog-install-${item().skillName}`} class={settingsAction} disabled={disabled() || !item().installable} onPress={() => { void openInstall(item()); }}><Text>{t('settings.skills.catalog.shared.actions.install')}</Text></Button>
      </SettingsGroup>}</Each>
    </If>
    <If when={!!cursor()}><Button testID="skills-catalog-more" class={settingsAction} disabled={disabled()} onPress={() => { void state.perform(operation => loadSource(operation, { more: true })); }}><Text>{t('settings.skills.catalog.page.actions.loadMoreSkills')}</Text></Button></If>
    <NativeSheet open={panelOpen()} closeOnSwipe={!state.busy() && !draftDirty()} closeOnBackdropPress={!state.busy() && !draftDirty()} closeOnEscape={false} onOpen={() => panelVisible.set(true)} onOpenChange={event => { if (!event.open) void closePanel(); }} onClose={() => { panelVisible.set(false); if (!panelOpen()) panel.set(null); }} popupClass="bg-background" popupStyle={{ height: 680 }}>
      <Scroll testID="skills-catalog-panel" class="flex-1" contentClass="p-5 gap-5 pb-10">
        <SettingsFeedback state={state} />
        <If when={panel() === 'add'}><SettingsGroup title={t('settings.skills.catalog.add.title')}>
          <SettingsInput testID="skills-catalog-name" title={t('settings.skills.catalog.add.field.catalogName')} value={add().label} disabled={disabled() || addCommitted()} onChange={value => changeAdd('label', value)} />
          <SettingsInput testID="skills-catalog-repository" title={t('settings.skills.catalog.add.field.repository')} value={add().source} disabled={disabled() || addCommitted()} onChange={value => changeAdd('source', value)} />
          <SettingsInput testID="skills-catalog-subpath" title={t('settings.skills.catalog.add.field.optionalSubpath')} value={add().subpath} disabled={disabled() || addCommitted()} onChange={value => changeAdd('subpath', value)} />
          <If when={identities().length > 0}><SettingsChoice testID="skills-catalog-scan-identity" title={t('settings.skills.catalog.shared.auth.description')} value={add().gitIdentityId} items={identities().map(identity => ({ value: identity.id, title: identity.name }))} disabled={disabled()} onChange={value => changeAdd('gitIdentityId', value)} /></If>
          <If when={scanCount() !== null}><Text>{t('settings.skills.catalog.shared.toast.foundSkills', { count: scanCount() ?? 0 })}</Text></If>
          <Button testID="skills-catalog-scan" class={settingsAction} disabled={disabled() || addCommitted() || !add().source.trim()} onPress={() => { void scan(); }}><Text>{t('settings.skills.catalog.shared.actions.scan')}</Text></Button>
          <Button testID="skills-catalog-save" class={settingsAction} disabled={disabled() || !addCommitted() && (scanStamp() !== scanIdentity() || !add().label.trim())} onPress={() => { void saveCatalog(); }}><Text>{t('settings.skills.catalog.page.actions.addCatalog')}</Text></Button>
        </SettingsGroup></If>
        <If when={panel() === 'install'}><SettingsGroup title={t('settings.skills.catalog.installSkill.title')}>
          <Text class="text-foreground">{installItem()?.skillName}</Text>
          <SettingsChoice testID="skills-catalog-destination" title={t('settings.skills.catalog.installSkill.field.destination')} value={location()} items={(['user-opencode', 'project-opencode', 'user-agents', 'project-agents'] as const).map(value => ({ value, title: t(`settings.skills.location.option.${value === 'user-opencode' ? 'userOpencode' : value === 'project-opencode' ? 'projectOpencode' : value === 'user-agents' ? 'userAgents' : 'projectAgents'}.label`) }))} disabled={disabled() || !!conflicts().length || installUnknown() || installCommitted()} onChange={value => { if (!disabled() && !conflicts().length && !installUnknown() && !installCommitted()) { location.set(value); receipt.set(null); } }} />
          <If when={location().startsWith('project-')}><SettingsChoice testID="skills-catalog-project" title={t('settings.skills.catalog.installSkill.field.project')} value={directory()} items={(projects() ?? []).map(project => ({ value: text(project.path), title: text(project.label) || text(project.path) }))} disabled={disabled() || projectError() || !!conflicts().length || installUnknown() || installCommitted()} onChange={value => { if (!disabled() && !conflicts().length && !installUnknown() && !installCommitted()) directory.set(value); }} /><If when={projectError()}><Button class={settingsAction} disabled={disabled()} onPress={() => { void state.perform(loadProjects); }}><Text>{t('settings.voice.volcengine.retry')}</Text></Button></If></If>
          <If when={identities().length > 0}><SettingsChoice title={t('settings.skills.catalog.shared.auth.description')} value={installIdentity()} items={identities().map(identity => ({ value: identity.id, title: identity.name }))} disabled={disabled() || !!conflicts().length || installUnknown() || installCommitted()} onChange={value => { if (!disabled() && !conflicts().length && !installUnknown() && !installCommitted()) installIdentity.set(value); }} /></If>
          <If when={conflicts().length > 0}><Text>{t('settings.skills.catalog.conflicts.description')}</Text><View class="flex-row gap-2"><Button testID="skills-conflicts-skip-all" class={settingsAction} disabled={disabled()} onPress={() => decisions.set(Object.fromEntries(conflicts().map(conflict => [conflict.skillName, 'skip'])))}><Text>{t('settings.skills.catalog.conflicts.actions.skipAll')}</Text></Button><Button testID="skills-conflicts-overwrite-all" class={settingsAction} disabled={disabled()} onPress={() => decisions.set(Object.fromEntries(conflicts().map(conflict => [conflict.skillName, 'overwrite'])))}><Text>{t('settings.skills.catalog.conflicts.actions.overwriteAll')}</Text></Button></View>
            <Each of={conflicts()}>{conflict => <SettingsChoice testID={`skills-conflict-${conflict().skillName}`} title={`${conflict().skillName} · ${t(conflict().scope === 'project' ? 'settings.skills.catalog.conflicts.scope.project' : 'settings.skills.catalog.conflicts.scope.user')} · ${conflict().source ?? ''}`} value={decisions()[conflict().skillName] ?? 'skip'} items={(['skip', 'overwrite'] as const).map(value => ({ value, title: t(`settings.skills.catalog.conflicts.decision.${value}`) }))} disabled={disabled()} onChange={value => { if (value === 'skip' || value === 'overwrite') decisions.set({ ...decisions(), [conflict().skillName]: value }); }} />}</Each>
          </If>
          <Each of={installed()}>{name => <Text>{name()}</Text>}</Each><Each of={skipped()}>{name => <Text class="text-muted-foreground">{name()}</Text>}</Each>
          <If when={installUnknown()}><Text class="text-destructive">{t('settings.common.writeUnconfirmed')}</Text></If>
          <Button testID="skills-catalog-install-confirm" class={settingsAction} disabled={disabled() || installUnknown() || installCommitted() || location().startsWith('project-') && (!directory() || projectError() || !projects()?.some(project => project.path === directory()))} onPress={() => { void install(); }}><Text>{t(conflicts().length ? 'settings.skills.catalog.conflicts.actions.continue' : 'settings.skills.catalog.installSkill.actions.install')}</Text></Button>
        </SettingsGroup></If>
        <Button testID="skills-catalog-panel-close" class={settingsAction} disabled={state.busy()} onPress={() => { void closePanel(); }}><Text>{t('settings.common.actions.cancel')}</Text></Button>
      </Scroll>
    </NativeSheet>
  </Scroll>;
}
