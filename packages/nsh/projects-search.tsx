import { cleanup, computed, effect, keymap, List, signal, Text, untracked, View, type ListRef } from 'nsh';
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
export function createProjectsSearchController(focusDirectory: () => string | undefined, active: () => boolean = () => true) {
  const operations = createPageOperations(active);
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
  /** Actual displayed route/modal admission, not merely mounted content. */
  active?: boolean;
  /** Close this surface only. Desktop must not pop the product NavStack. */
  onClose?: () => void;
}

export function ProjectsSearchPage(props: ProjectsSearchProps) {
  const content = ProjectsSearchContent(props);
  return <NavPage title={t('commandPalette.title')} headerBackTitle="" class="flex-1 bg-background">{content}</NavPage>;
}

export type ProjectsSearchContentProps = ProjectsSearchProps & { presentation?: 'page' | 'dialog'; onCompositionChange?: (composing: boolean) => void };

/** One search/controller/row owner for iOS navigation and the desktop Dialog. */
export function ProjectsSearchContent(props: ProjectsSearchContentProps) {
  const controller = createProjectsSearchController(() => props.focusDirectory, () => props.active !== false), input = signal('');
  const expanded = signal<SearchGroup[]>([]), composing = signal(false), highlighted = signal<string | null>(null);
  const active = () => props.active !== false && controller.current();
  let list: ListRef | undefined, moved = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() { if (timer) clearTimeout(timer); timer = undefined; controller.cancel(); }
  effect(() => { const current = active(); props.focusDirectory; untracked(() => { cancel(); if (current) void controller.search(input()); }); });
  cleanup(() => { if (timer) clearTimeout(timer); props.onCompositionChange?.(false); });
  function close() { if (!active() || composing()) return; cancel(); props.onClose?.(); }
  function select(work: () => void) { if (!active() || composing()) return; cancel(); props.onClose?.(); work(); }
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
  function choose(key: string | null) {
    if (!active() || composing()) return;
    const item = rows().find(row => row.key === key);
    if (!item || item.heading) return;
    if (item.key.startsWith('more:')) item.select(); else select(item.select);
  }
  function move(direction: -1 | 1) {
    const candidates = rows().filter(row => !row.heading);
    if (!candidates.length) return;
    const current = candidates.findIndex(row => row.key === highlighted());
    const index = current < 0 ? direction === 1 ? 0 : candidates.length - 1 : (current + direction + candidates.length) % candidates.length;
    const next = candidates[index]!;
    moved = true; highlighted.set(next.key);
    list?.scrollToIndex({ index: rows().indexOf(next), animated: false, viewPosition: .5 });
  }
  effect(() => {
    const source = rows();
    untracked(() => { if (!moved || !source.some(row => row.key === highlighted() && !row.heading)) highlighted.set(source.find(row => !row.heading)?.key ?? null); });
  });
  effect(() => {
    if (props.presentation !== 'dialog' || !active() || composing()) return;
    cleanup(keymap.bind({ up: () => untracked(() => move(-1)), down: () => untracked(() => move(1)), enter: () => untracked(() => choose(highlighted())), escape: () => untracked(close) }, { when: 'always', repeat: true }));
  });
  function schedule() { cancel(); if (active() && !composing()) timer = setTimeout(() => { timer = undefined; if (active() && !composing()) void controller.search(input()); }, 250); }
  const desktop = () => props.presentation === 'dialog';
  return <View class="flex-1 min-h-0" accessibilityLabel={t('commandPalette.title')}>
    <View class={desktop() ? 'p-3 gap-2' : 'p-4 gap-2'}>
      <Input testID="projects-global-search" class={`${desktop() ? 'min-h-10' : 'min-h-12'} px-3 py-3 rounded-xl bg-secondary text-foreground`} value={input()} placeholder={t('commandPalette.input.placeholder')} accessibilityLabel={t('commandPalette.input.placeholder')} autoFocus={desktop()} disabled={!active()}
        onCompositionChange={event => { composing.set(event.composing); props.onCompositionChange?.(event.composing); if (event.composing) cancel(); else schedule(); }} onSubmit={() => choose(highlighted())}
        onChange={event => { input.set(event.value); expanded.set([]); moved = false; schedule(); }} />
      <Each of={Object.entries(visibleErrors())}>{entry => <View class="gap-1"><Text class="text-sm text-destructive">{t(entry()[0] === 'sessions' ? 'commandPalette.error.sessions' : entry()[0] === 'messages' ? 'commandPalette.error.messages' : 'commandPalette.error.files')}</Text><Text class="text-xs text-muted-foreground">{entry()[1]}</Text></View>}</Each>
      <If when={Object.keys(visibleErrors()).length > 0}><Button testID="projects-search-retry" class={quiet} disabled={!active() || composing()} onPress={() => { cancel(); if (active() && !composing()) void controller.search(input()); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button></If>
    </View>
    <List testID="projects-search-results" ref={node => { list = node; }} role={desktop() ? 'listbox' : undefined} class="flex-1" contentClass={desktop() ? 'px-3 pb-3' : 'px-4 pb-6 gap-2'} each={rows()} keyExtractor={row => row.key}>{row =>
      <If when={row().heading} else={
        <Button testID={`projects-search-${row().key}`} role={desktop() ? 'option' : undefined} selected={desktop() && highlighted() === row().key} disabled={!active() || composing()}
          class={desktop() ? 'min-h-10 rounded-lg px-3 py-2 gap-1 active:bg-accent selected:bg-accent' : 'min-h-14 rounded-xl bg-card p-3 gap-1'} onPress={() => choose(row().key)}>
          <Text class="text-foreground" style={{ numberOfLines: 1 }}>{row().title}</Text>
          <If when={subtitle(row())}><View class="gap-1">
            <If when={speaker(row())}><Text class="text-xs text-muted-foreground">{speaker(row())}</Text></If>
            <Text class="text-xs text-muted-foreground" style={{ numberOfLines: desktop() ? 1 : 3 }}>{subtitle(row())}</Text>
          </View></If>
        </Button>
      }><Text testID={`projects-search-${row().key}`} class="text-xs text-muted-foreground pt-3 px-1">{row().title}</Text></If>
    }</List>
    <If when={controller.pending().length > 0}><View class="p-4 flex-row gap-2"><Icon name="loader-4" size={16} /><Text class="text-muted-foreground">{t('common.loading')}</Text></View></If>
    <If when={controller.pending().length === 0 && Object.keys(controller.errors()).length === 0 && rows().length === 0}><Text class="p-4 text-muted-foreground">{t('commandPalette.empty.noResults')}</Text></If>
  </View>;
}
