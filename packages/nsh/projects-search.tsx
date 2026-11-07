import { cleanup, computed, effect, List, signal, Text, untracked, View } from 'nsh';
import { Button, Input, NavPage } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { nameOf, type ChatTarget, type Project } from './model';
import { app } from './state';
import { createPageOperations } from './page-operations';
import { previewSearchGroup, projectSearchGroups, searchFilesFrom, searchMessagesFrom, searchSessionsFrom, type ProjectSearchCommand, type SearchFile, type SearchGroup, type SearchMessage, type SearchSession } from './projects-search-core';

export type { ProjectSearchCommand } from './projects-search-core';
type Domain = 'sessions' | 'messages' | 'files';
type SearchRow = { key: string; title: string; subtitle: string; speaker?: string; select: () => void; heading?: false } | { key: string; title: string; heading: true };
const subtitle = (row: SearchRow) => row.heading ? '' : row.subtitle;
const speaker = (row: SearchRow) => row.heading ? '' : row.speaker;
const quiet = 'min-h-11 px-3 py-2 rounded-xl active:bg-accent items-center justify-center';

/** Each authority settles independently: one failed domain must not erase successful results. */
export function createProjectsSearchController(focusDirectory: () => string | undefined) {
  const operations = createPageOperations();
  const term = signal(''), sessions = signal<SearchSession[]>([]), messages = signal<SearchMessage[]>([]), files = signal<SearchFile[]>([]);
  const pending = signal<Domain[]>([]), errors = signal<Partial<Record<Domain, string>>>({});
  let revision = 0, alive = true, fileDirectory: string | undefined;
  const current = () => alive && operations.current();
  operations.onRetire(() => { revision++; pending.set([]); });
  async function search(value: string) {
    if (!current()) return;
    const lane = operations.capture(), request = lane.request;
    const query = value.trim(), changedQuery = query !== term();
    const sequence = ++revision, directory = focusDirectory()?.trim();
    const valid = () => alive && lane.current() && sequence === revision;
    if (changedQuery) { sessions.set([]); messages.set([]); files.set([]); }
    if (directory !== fileDirectory) files.set([]);
    fileDirectory = directory;
    term.set(query); errors.set({}); pending.set(query ? directory ? ['sessions', 'messages', 'files'] : ['sessions', 'messages'] : ['sessions']);
    if (!query) { messages.set([]); files.set([]); }
    else if (!directory) files.set([]);
    async function settle(domain: Domain, work: () => Promise<void>) {
      try { await work(); }
      catch (failure) { if (valid()) errors.set({ ...errors(), [domain]: String(failure) }); }
      finally { if (valid()) pending.set(pending().filter(item => item !== domain)); }
    }
    const title = settle('sessions', async () => {
      const hits = searchSessionsFrom(await request(`/api/session?parentID=null&limit=30&order=desc${query ? `&search=${encodeURIComponent(query)}` : ''}`));
      if (valid()) sessions.set(hits);
    });
    const content = query ? settle('messages', async () => {
      const hits = searchMessagesFrom(await request(`/api/yuri/content-search?q=${encodeURIComponent(query)}&limit=30`));
      if (valid()) messages.set(hits);
    }) : Promise.resolve();
    // The current Focus is the only file-search scope. Never enumerate all project paths.
    const find = query && directory ? settle('files', async () => {
      const hits = searchFilesFrom(await request(`/api/fs/find?location%5Bdirectory%5D=${encodeURIComponent(directory)}&query=${encodeURIComponent(query)}&limit=40&type=file`), directory);
      if (valid() && focusDirectory()?.trim() === directory) files.set(hits);
    }) : Promise.resolve();
    await Promise.all([title, content, find]);
  }
  function cancel() { revision++; pending.set([]); }
  function dispose() { alive = false; cancel(); }
  cleanup(dispose);
  return { term, sessions, messages, files, pending, errors, current, search, cancel, dispose };
}

export interface ProjectsSearchProps {
  /** Main owns the complete available command/settings inventory and actual route actions. */
  commands: ProjectSearchCommand[];
  /** Undefined when no chat/project Focus is known; files are then not searched. */
  focusDirectory?: string;
  /** Host catalog only; no per-project filesystem enumeration. Defaults to the root snapshot. */
  projects?: Project[];
  /** Like Web handleOpenProject: main opens the unsent draft for this project/path. */
  onOpenProject?: (project: Project) => void;
  onOpenChat: (target: ChatTarget, options?: { messageID?: string }) => void;
  onOpenFile: (directory: string, path: string) => void;
}

export function ProjectsSearchPage(props: ProjectsSearchProps) {
  const controller = createProjectsSearchController(() => props.focusDirectory), input = signal('');
  const expanded = signal<SearchGroup[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => { const active = controller.current(); props.focusDirectory; untracked(() => { if (timer) clearTimeout(timer); if (active) void controller.search(input()); }); });
  cleanup(() => { if (timer) clearTimeout(timer); });
  function select(work: () => void) { if (timer) clearTimeout(timer); controller.cancel(); work(); }
  const groups = computed(() => {
    const settledQuery = controller.current() && input().trim() === controller.term();
    return projectSearchGroups({ query: input(), commands: props.commands, projects: props.onOpenProject ? props.projects ?? app.projects() : [], sessions: settledQuery ? controller.sessions() : [], messages: settledQuery ? controller.messages() : [], files: settledQuery ? controller.files().filter(row => row.directory === props.focusDirectory?.trim()) : [] });
  });
  const visibleErrors = computed(() => controller.current() && controller.term() === input().trim() ? controller.errors() : {});
  const rows = computed(() => {
    const result: SearchRow[] = [], value = groups();
    const items: Record<SearchGroup, SearchRow[]> = {
      commands: value.commands.map(command => ({ key: `command:${command.id}`, title: command.title, subtitle: '', select: command.onSelect })),
      settings: value.settings.map(command => ({ key: `command:${command.id}`, title: command.title, subtitle: '', select: command.onSelect })),
      projects: value.projects.map(project => ({ key: `project:${project.id}`, title: project.name || nameOf(project.path), subtitle: project.path, select: () => props.onOpenProject?.(project) })),
      sessions: value.sessions.map(({ session, hit }) => ({ key: hit ? `message:${session.id}:${hit.messageID}` : `session:${session.id}`, title: hit?.title || session.title || t('commandPalette.session.untitled'), subtitle: hit ? hit.snippet.replace(/\s+/g, ' ') : session.directory, speaker: hit ? t(hit.role === 'user' ? 'commandPalette.message.user' : 'commandPalette.message.assistant') : '', select: () => props.onOpenChat({ kind: 'session', id: session.id, title: hit?.title || session.title, directory: hit?.directory || session.directory }, hit ? { messageID: hit.messageID } : undefined) })),
      files: value.files.map(row => ({ key: `file:${row.directory}:${row.path}`, title: nameOf(row.path), subtitle: row.path, select: () => props.onOpenFile(row.directory, row.path) })),
    };
    const titles = { commands: t('settings.page.commands.title'), settings: t('settings.view.home.title'), sessions: t('layout.mainTab.chat'), files: t('layout.mainTab.files'), projects: t('sessions.sidebar.projectsTitle') };
    for (const group of value.order) {
      if (!items[group].length) continue;
      const { visible, remaining } = previewSearchGroup(items[group], input(), expanded().includes(group));
      result.push({ key: `group:${group}`, title: `${titles[group]} ${items[group].length}`, heading: true }, ...visible);
      if (remaining) result.push({ key: `more:${group}`, title: t('commandPalette.group.showMore', { count: remaining }), subtitle: '', select: () => expanded.set([...expanded(), group]) });
    }
    return result;
  });
  return <NavPage title={t('commandPalette.title')} headerBackTitle="" class="flex-1 bg-background">
    <View class="p-4 gap-2">
      <Input testID="projects-global-search" class="min-h-12 px-3 py-3 rounded-xl bg-secondary text-foreground" value={input()} placeholder={t('commandPalette.input.placeholder')} onChange={event => { input.set(event.value); expanded.set([]); controller.cancel(); if (timer) clearTimeout(timer); timer = setTimeout(() => { void controller.search(input()); }, 250); }} />
      <Each of={Object.entries(visibleErrors())}>{entry => <View class="gap-1"><Text class="text-sm text-destructive">{t(entry()[0] === 'sessions' ? 'commandPalette.error.sessions' : entry()[0] === 'messages' ? 'commandPalette.error.messages' : 'commandPalette.error.files')}</Text><Text class="text-xs text-muted-foreground">{entry()[1]}</Text></View>}</Each>
      <If when={Object.keys(visibleErrors()).length > 0}><Button testID="projects-search-retry" class={quiet} onPress={() => { if (timer) clearTimeout(timer); void controller.search(input()); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button></If>
    </View>
    <List testID="projects-search-results" class="flex-1" contentClass="px-4 pb-6 gap-2" each={rows()} keyExtractor={row => row.key}>{row =>
      <If when={row().heading} else={
        <Button testID={`projects-search-${row().key}`} class="min-h-14 rounded-xl bg-card p-3 gap-1" onPress={() => {
          const item = row();
          if (item.heading) return;
          if (item.key.startsWith('more:')) item.select(); else select(item.select);
        }}>
          <Text class="text-foreground" style={{ numberOfLines: 1 }}>{row().title}</Text>
          <If when={subtitle(row())}><View class="gap-1">
            <If when={speaker(row())}><Text class="text-xs text-muted-foreground">{speaker(row())}</Text></If>
            <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 3 }}>{subtitle(row())}</Text>
          </View></If>
        </Button>
      }><Text testID={`projects-search-${row().key}`} class="text-xs text-muted-foreground pt-3 px-1">{row().title}</Text></If>
    }</List>
    <If when={controller.pending().length > 0}><View class="p-4 flex-row gap-2"><Icon name="loader-4" size={16} /><Text class="text-muted-foreground">{t('common.loading')}</Text></View></If>
    <If when={controller.pending().length === 0 && Object.keys(controller.errors()).length === 0 && rows().length === 0}><Text class="p-4 text-muted-foreground">{t('commandPalette.empty.noResults')}</Text></If>
  </NavPage>;
}
