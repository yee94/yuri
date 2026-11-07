import { cleanup, computed, effect, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, Input, NavPage } from 'nsh/base';
import { NativeSelect as Select } from './native-select';
import { createProjectIdFromPath } from '../ui/src/lib/projectId';
import { normalizePath } from '../ui/src/lib/pathNormalization';
import { Icon } from './Icon';
import { t } from './i18n';
import { list, nameOf, projectsFrom, record, text, unwrap, type Project } from './model';
import { app, captureHostRequest, epoch } from './state';

type Entry = { name: string; path: string };
type Identity = { id: string; name: string };
const normalize = (path: string) => normalizePath(path) ?? '';
const action = 'min-h-11 px-4 py-3 rounded-xl bg-secondary active:bg-accent items-center justify-center disabled:opacity-40';
const quiet = 'min-h-11 px-3 py-2 rounded-xl active:bg-accent items-center justify-center';
const field = 'min-h-12 px-3 py-3 rounded-xl bg-secondary text-foreground';

export function projectDirectoryLocation(input: string, home: string) {
  const value = input.trim().replace(/\\/g, '/');
  const absolute = value === '~' ? home : value.startsWith('~/') ? home + value.slice(1) : value;
  const separator = absolute.lastIndexOf('/');
  return { target: absolute ? normalize(absolute) : '', parent: absolute.endsWith('/') ? normalize(absolute) : separator === 0 ? '/' : separator > 0 ? normalize(absolute.slice(0, separator)) : '', filter: absolute.endsWith('/') ? '' : absolute.slice(separator + 1) };
}

/** Host filesystem, not the phone's filesystem. A failed read never authorizes mkdir. */
export function createProjectDirectoryController() {
  const request = captureHostRequest();
  const home = signal(''), input = signal('~/'), entries = signal<Entry[]>([]), listedPath = signal('');
  const loading = signal(false), pending = signal(false), error = signal(''), browseError = signal('');
  const clone = signal(false), remote = signal(''), identity = signal<string | null>(null), identities = signal<Identity[]>([]);
  const showHidden = signal(false), missingPath = signal('');
  const prepared = signal<{ key: string; path: string } | null>(null);
  const generation = epoch();
  let alive = true, browseRevision = 0, requestedPath = '';
  const current = () => alive && generation === epoch();
  const scope = () => { const started = epoch(); return () => current() && started === epoch(); };
  const location = computed(() => projectDirectoryLocation(input(), home()));
  const visibleEntries = computed(() => listedPath() === location().parent ? entries().filter(entry => entry.name.toLowerCase().startsWith(location().filter.toLowerCase()) && (showHidden() || location().filter.startsWith('.') || !entry.name.startsWith('.'))) : []);
  async function browse(force = false) {
    if (!current() || !home() || !location().parent) return;
    const path = location().parent;
    if (!force && loading() && path === requestedPath) return;
    const revision = ++browseRevision;
    if (!force && path === listedPath()) { requestedPath = ''; loading.set(false); browseError.set(''); missingPath.set(''); return; }
    const valid = scope(); requestedPath = path; loading.set(true); browseError.set(''); missingPath.set('');
    try {
      const value = record(await request(`/api/fs/list?path=${encodeURIComponent(path)}`));
      if (!Array.isArray(value.entries)) throw new Error('Invalid directory listing');
      const rows = list(value.entries).filter(row => row.isDirectory === true).map(row => ({ name: text(row.name), path: text(row.path) }));
      if (rows.some(row => !row.name || !row.path)) throw new Error('Invalid directory entry');
      if (valid() && revision === browseRevision) { entries.set(rows.sort((a, b) => a.name.localeCompare(b.name))); listedPath.set(path); }
    } catch (failure) {
      if (valid() && revision === browseRevision) { browseError.set(String(failure)); if (record(failure).status === 404) missingPath.set(path); }
    } finally { if (valid() && revision === browseRevision) { requestedPath = ''; loading.set(false); } }
  }
  async function initialize() {
    if (!current()) return;
    const valid = scope(); loading.set(true); error.set('');
    try {
      const value = record(await request('/api/fs/home'));
      const path = normalize(text(value.home));
      if (!path) throw new Error('Invalid filesystem home');
      if (valid()) { home.set(path); await browse(true); }
    } catch (failure) { if (valid()) error.set(String(failure)); }
    finally { if (valid()) loading.set(false); }
  }
  async function loadIdentities() {
    if (!current()) return;
    const valid = scope();
    try {
      const value = await request('/api/git/identities');
      if (!Array.isArray(value)) throw new Error('Invalid Git identities');
      if (valid()) identities.set(list(value).map(row => ({ id: text(row.id), name: text(row.name) })).filter(row => row.id));
    } catch (failure) { if (valid()) error.set(String(failure)); }
  }
  function edit(value: string) { input.set(value); void browse(); }
  function navigate(path: string) { edit(normalize(path) + (normalize(path) === '/' ? '' : '/')); }
  function parent() { const path = location().parent; if (path && path !== '/') navigate(path.slice(0, path.lastIndexOf('/')) || '/'); }
  async function add(path: string, options: { clone?: boolean; quick?: boolean } = {}) {
    if (!current() || pending() || !home()) return;
    const valid = scope(), target = normalize(path);
    if (!path.trim() || !/^(\/|[A-Za-z]:\/)/.test(target)) { error.set(t('directoryExplorerDialog.toast.selectValidDirectoryPath')); return; }
    if (options.clone && !remote().trim()) { error.set(t('directoryExplorerDialog.toast.cloneUrlRequired')); return; }
    const remoteUrl = remote().trim(), gitIdentityId = identity();
    const key = JSON.stringify([target, options.clone ? remoteUrl : null, options.clone ? gitIdentityId : null]);
    pending.set(true); error.set('');
    try {
      let selected = target;
      if (prepared()?.key === key) selected = prepared()!.path;
      else if (options.clone) {
        const result = record(await request('/api/fs/clone', 'POST', { remoteUrl, destinationPath: target, gitIdentityId }));
        if (!valid()) return;
        if (result.success !== true || !text(result.path)) throw new Error('Invalid clone result');
        selected = normalize(text(result.path)); prepared.set({ key, path: selected });
      } else {
        try {
          const result = record(await request(`/api/fs/list?path=${encodeURIComponent(target)}`));
          if (!Array.isArray(result.entries)) throw new Error('Invalid directory listing');
        } catch (failure) {
          if (!valid()) return;
          if (record(failure).status !== 404 || options.quick) throw failure;
          const result = record(await request('/api/fs/mkdir', 'POST', { path: target }));
          if (!valid()) return;
          if (result.success !== true || normalize(text(result.path)) !== target) throw new Error('Invalid mkdir result');
        }
        if (!valid()) return;
        prepared.set({ key, path: selected });
      }
      if (!valid()) return;
      // A clone/mkdir checkpoint survives a failed registry write: Retry must not clone twice.
      const settings = record(unwrap(await request('/api/config/settings')));
      if (!valid()) return;
      if (!Array.isArray(settings.projects)) throw new Error('Invalid project catalog');
      const rows = list(settings.projects), existing = rows.find(row => normalize(text(row.path)) === selected);
      const projectID = existing ? text(existing.id) : createProjectIdFromPath(selected);
      if (!projectID) throw new Error(t('directoryExplorerDialog.toast.selectValidDirectoryPath'));
      const now = Date.now();
      const project = existing ?? { id: projectID, path: selected, label: nameOf(selected), addedAt: now, lastOpenedAt: now };
      const result = record(unwrap(await request('/api/config/settings', 'PUT', { projects: existing ? rows : [project, ...rows], activeProjectId: projectID })));
      if (!valid()) return;
      if (!Array.isArray(result.projects)) throw new Error('Invalid saved project catalog');
      const confirmed = projectsFrom(result), added = confirmed.find(row => row.id === projectID && normalize(row.path) === selected);
      if (!added) throw new Error('Project registration was not confirmed');
      app.projects.set(confirmed); prepared.set(null); return added;
    } catch (failure) { if (valid()) error.set(String(failure)); }
    finally { if (valid()) pending.set(false); }
  }
  function dispose() { alive = false; browseRevision++; }
  cleanup(dispose);
  return { home, input, entries, listedPath, loading, pending, error, browseError, clone, remote, identity, identities, showHidden, prepared, missingPath, location, visibleEntries, current, initialize, browse, edit, navigate, parent, add, loadIdentities, dispose };
}

export interface ProjectDirectoryProps {
  /** Quick-add keeps this page; a confirmed primary add opens the native new-session draft. */
  onAdded: (project: Project, options: { openDraft: boolean }) => void;
}

export function ProjectDirectoryPage(props: ProjectDirectoryProps) {
  const controller = createProjectDirectoryController();
  effect(() => { app.connection(); untracked(() => { void controller.initialize(); }); });
  const added = (path: string) => app.projects().some(project => normalize(project.path) === normalize(path));
  async function submit(path: string, quick = false) {
    const project = await controller.add(path, { clone: !quick && controller.clone(), quick });
    if (project && controller.current()) props.onAdded(project, { openDraft: !quick });
  }
  const createTarget = () => controller.missingPath() === controller.location().target || (controller.listedPath() === controller.location().parent && !!controller.location().filter && !controller.entries().some(entry => entry.name === controller.location().filter));
  return <NavPage title={t('directoryExplorerDialog.title')} headerBackTitle="" popOnBack={!controller.pending()} popOnSwipe={!controller.pending()} class="flex-1 bg-background">
    <Scroll class="flex-1" contentClass="p-4 gap-4">
      <Text class="text-sm text-muted-foreground">{t('directoryExplorerDialog.description')}</Text>
      <Input testID="projects-directory-path" class={field} value={controller.input()} disabled={controller.pending()} autoCapitalize="none" autoCorrect={false} placeholder={t('directoryExplorerDialog.pathInput.placeholder')} onChange={event => controller.edit(event.value)} />
      <Button testID="projects-directory-mode-toggle" class={quiet} disabled={controller.pending()} onPress={() => { controller.clone.set(!controller.clone()); if (controller.clone()) void controller.loadIdentities(); }}><Text class="text-foreground">{t(controller.clone() ? 'directoryExplorerDialog.actions.addLocalProject' : 'directoryExplorerDialog.actions.cloneRepository')}</Text></Button>
      <If when={controller.clone()}><View class="gap-3">
        <Input testID="projects-clone-url" class={field} value={controller.remote()} disabled={controller.pending()} autoCapitalize="none" autoCorrect={false} placeholder={t('directoryExplorerDialog.clone.remoteUrlPlaceholder')} onChange={event => controller.remote.set(event.value)} />
        <Select value={controller.identity()} items={controller.identities().map(identity => ({ value: identity.id, title: identity.name }))} cleanable searchable disabled={controller.pending()} accessibilityLabel={t('gitView.header.identityTooltip')} onChange={event => controller.identity.set(event.value)} trigger={<View class={action}><Text class="text-foreground">{controller.identities().find(identity => identity.id === controller.identity())?.name || t('gitView.header.noIdentity')}</Text></View>} popupClass="bg-background rounded-t-3xl p-4" />
        <Button class={quiet} disabled={controller.pending()} onPress={() => { void controller.loadIdentities(); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button>
      </View></If>
      <If when={controller.error()}><Text class="text-sm text-destructive">{controller.error()}</Text></If>
      <If when={controller.browseError()}><Text class="text-sm text-destructive">{controller.browseError()}</Text></If>
      <Button class={quiet} disabled={controller.pending()} onPress={() => { void (controller.home() ? controller.browse(true) : controller.initialize()); }}><Icon name="refresh" size={18} /><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button>
      <View class="flex-row items-center gap-2"><Text class="flex-1 text-sm text-muted-foreground">{t('directoryExplorerDialog.browse.directories')}</Text><Button class={quiet} onPress={() => controller.showHidden.set(!controller.showHidden())}><Text class="text-foreground">{t('directoryExplorerDialog.toggle.showHidden')}{controller.showHidden() ? ' ✓' : ''}</Text></Button></View>
      <If when={controller.location().parent !== '/' && !!controller.location().parent}><Button class={quiet} disabled={controller.pending()} onPress={controller.parent}><Icon name="arrow-up-s" size={18} /><Text class="text-foreground">{t('directoryExplorerDialog.browse.parentDirectory')}</Text></Button></If>
      <Each of={controller.visibleEntries()}>{entry => <View class="flex-row items-center gap-2 bg-card rounded-xl">
        <Button class={`flex-1 ${quiet}`} disabled={controller.pending()} onPress={() => controller.navigate(entry().path)}><Text class="text-foreground">{entry().name}</Text></Button>
        <Button class={quiet} disabled={controller.pending() || added(entry().path)} onPress={() => { void submit(entry().path, true); }}><Text class="text-foreground">{t(added(entry().path) ? 'directoryExplorerDialog.browse.addedBadge' : 'directoryExplorerDialog.browse.quickAdd')}</Text></Button>
      </View>}</Each>
      <If when={controller.loading()}><Text class="text-muted-foreground">{t('directoryExplorerDialog.browse.loading')}</Text></If>
      <If when={!controller.loading() && !controller.browseError() && controller.visibleEntries().length === 0}><Text class="text-muted-foreground">{t('directoryExplorerDialog.browse.empty')}</Text></If>
    </Scroll>
    <View class="p-4 border-t border-border"><Button testID="projects-directory-submit" class={action} disabled={controller.pending() || !controller.home() || !controller.location().target || added(controller.location().target) || (controller.clone() && !controller.remote().trim())} onPress={() => { void submit(controller.location().target); }}><Text class="text-foreground">{t(added(controller.location().target) ? 'directoryExplorerDialog.actions.alreadyAdded' : controller.pending() ? controller.clone() ? 'directoryExplorerDialog.actions.cloning' : 'directoryExplorerDialog.actions.adding' : controller.clone() ? 'directoryExplorerDialog.actions.cloneAndAdd' : createTarget() ? 'directoryExplorerDialog.actions.createAndAdd' : 'directoryExplorerDialog.actions.addProject')}</Text></Button></View>
  </NavPage>;
}
