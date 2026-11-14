import { Scroll, Text, View, effect, signal, untracked } from 'nsh';
import { Button, Input, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { Highlighted, Surface, alpha, fontSize } from '../core/ui';
import {
  markRead,
  searchSessionContent,
  searchSessionsByTitle,
  setActiveProject,
  setViewingSession,
  type SessionContentHit,
} from '../core/store';
import {
  hostAvailable,
  hostName,
  remoteMarkRead,
  remoteProjects as remoteProjectCatalog,
  remoteSearchSessions,
  remoteSessionKey,
  remoteHubId,
  remoteOwner,
} from '../core/remote';
import { homeModel, localSearchNodes, searchSessionNode, type Node, type ProjectItem } from './model';
import { activeStack, openSession, tabBarInset } from '../shell/nav';

type ProjectHit = ProjectItem;

function SearchRow(props: {
  testID: string;
  title: string;
  subtitle?: string;
  snippet?: string;
  machine?: string;
  query: string;
  icon?: 'chat-thread' | 'folder';
  onPress: () => void;
}) {
  return (
    <View
      testID={props.testID}
      role="button"
      onPress={props.onPress}
      activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
      style={{
        minHeight: 46,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 7,
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 9,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: alpha(colors.muted(), 0.9),
        }}
      >
        <Icon name={props.icon ?? 'chat-thread'} size={14} tone="muted" />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Highlighted
            value={() => props.title}
            query={() => props.query}
            style={{ flexShrink: 1, fontSize: fontSize.sessionTitle + 1, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}
          />
          <If when={!!props.machine}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 }}>
              <Icon name="computer" size={10} tone="muted" />
              <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                {props.machine ?? ''}
              </Text>
            </View>
          </If>
        </View>
        <If when={!!(props.snippet || props.subtitle)}>
          <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
            {props.snippet || props.subtitle || ''}
          </Text>
        </If>
      </View>
      <Icon name="arrow-right-s" size={13} tone="muted" />
    </View>
  );
}

/** Web `CommandPalette` page presentation: sessions by title/content, then projects. */
export function SearchPage() {
  const query = signal('');
  const sessions = signal<Node[]>([]);
  const projectHits = signal<ProjectHit[]>([]);
  const snippets = signal<Record<string, string>>({});
  const searching = signal(false);
  const failure = signal('');
  let serial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (value: string, current: number) => {
    const lower = value.toLowerCase();
    const model = homeModel();
    projectHits.set(
      model.projects.filter((project) =>
        [project.name, project.path, project.remote?.hostName].some((field) =>
          field?.toLowerCase().includes(lower),
        ),
      ),
    );
    searching.set(true);
    failure.set('');
    const found: Node[] = [];
    const snippetById: Record<string, string> = {};
    const seen = new Set<string>();
    const push = (node: Node) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      found.push(node);
    };
    const results = await Promise.allSettled([
      searchSessionsByTitle(value),
      searchSessionContent(value),
      ...remoteProjectCatalog()
        .filter((project) => hostAvailable(project.hostId))
        .map(async (project) => ({ hostId: project.hostId, rows: await remoteSearchSessions(project.hostId, value) })),
    ]);
    if (current !== serial) return;
    // Local title search; its failure falls back to the loaded catalog, never to an empty success.
    const titleResult = results[0];
    if (titleResult?.status === 'fulfilled') {
      for (const row of titleResult.value) push(searchSessionNode(row, row.directory));
    } else {
      for (const node of localSearchNodes(lower)) push(node);
    }
    const contentResult = results[1];
    if (contentResult?.status === 'fulfilled') {
      for (const hit of contentResult.value as SessionContentHit[]) {
        if (!hit.directory) continue;
        const node = searchSessionNode(
          {
            id: hit.sessionID,
            title: hit.title || t('mobile.sessions.untitled'),
            directory: hit.directory,
            updated: hit.createdAt,
            activity: hit.createdAt,
            created: hit.createdAt,
            pinned: false,
            archived: false,
          },
          hit.directory,
        );
        snippetById[node.id] = hit.snippet;
        push(node);
      }
    }
    for (const result of results.slice(2)) {
      if (result.status !== 'fulfilled') continue;
      const { hostId, rows } = result.value as { hostId: string; rows: Awaited<ReturnType<typeof remoteSearchSessions>> };
      for (const row of rows) {
        const project = remoteOwner(hostId, row.directory);
        if (!project) continue;
        push(
          searchSessionNode(row, row.directory, {
            hostId,
            hostName: hostName(hostId),
            sessionID: row.id,
            directory: row.directory,
            projectId: project.id,
          }),
        );
      }
    }
    const failed = results.slice(0, 2).every((result) => result.status === 'rejected');
    if (failed) failure.set(t('sessions.sidebar.empty.noMatches.description'));
    sessions.set(found);
    snippets.set(snippetById);
    searching.set(false);
  };

  effect(() => {
    const value = query();
    untracked(() => {
      serial += 1;
      const current = serial;
      if (timer !== undefined) clearTimeout(timer);
      const trimmed = value.trim();
      if (!trimmed) {
        sessions.set([]);
        projectHits.set([]);
        snippets.set({});
        failure.set('');
        searching.set(false);
        return;
      }
      timer = setTimeout(() => void run(trimmed, current), 200);
    });
  });

  const openProject = (project: ProjectItem) => {
    setActiveProject(project.id);
    activeStack().pop();
  };

  const openNode = (node: Node) => {
    const project = homeModel().projects.find((entry) =>
      node.remote ? entry.id === node.remote.projectId : entry.worktrees.some((group) => group.path === node.directory),
    );
    if (project) setActiveProject(project.id);
    setViewingSession(node.id);
    if (node.remote) void remoteMarkRead(node.remote.hostId, node.remote.sessionID, false).catch(() => undefined);
    else void markRead(node.id, false);
    openSession({
      id: node.id,
      title: node.title,
      directory: node.directory,
      ...(node.remote
        ? {
            remote: {
              hubId: remoteHubId(),
              hostId: node.remote.hostId,
              projectId: node.remote.projectId,
              ...(remoteProjectCatalog().find((entry) => entry.id === node.remote!.projectId)?.remoteProjectId
                ? { remoteProjectId: remoteProjectCatalog().find((entry) => entry.id === node.remote!.projectId)!.remoteProjectId }
                : {}),
            },
          }
        : {}),
    });
  };

  return (
    <NavPage title={t('commandPalette.title')} class="flex-1" style={{ backgroundColor: colors.background() }}>
      <Scroll
        class="flex-1"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentStyle={{ paddingBottom: tabBarInset() + 24 }}
      >
        <View style={{ width: '100%', maxWidth: 452, alignSelf: 'center', paddingHorizontal: space.pageInset, gap: 14 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 12,
              minHeight: 40,
              borderRadius: radius.control,
              backgroundColor: alpha(colors.muted(), 0.9),
              backdropFilter: 'blur(18px) saturate(1.3)',
              glassEffect: 'regular',
            }}
          >
            <Icon name="search" size={15} tone="muted" />
            <Input
              testID="global-search-input"
              value={query()}
              onChange={(event) => query.set(event.value)}
              placeholder={t('sessions.sidebar.header.search.placeholder')}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                minHeight: 38,
                fontSize: 14,
                color: colors.foreground(),
                placeholderColor: colors.mutedForeground(),
              }}
            />
            <If when={query().length > 0}>
              <Button
                onPress={() => query.set('')}
                accessibilityLabel={t('mobile.sessions.clearSearchAria')}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: alpha(colors.mutedForeground(), 0.16),
                }}
              >
                <Icon name="close" size={12} tone="muted" />
              </Button>
            </If>
          </View>

          <If when={searching()}>
            <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('common.loading')}</Text>
          </If>
          <If when={!!failure()}>
            <Text style={{ fontSize: 12, color: colors.destructive() }}>{failure()}</Text>
          </If>

          <If when={projectHits().length > 0}>
            <View style={{ gap: 6 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.mutedForeground(), paddingHorizontal: 4 }}>
                {t('mobile.sessions.search.section.projects')}
              </Text>
              <Surface style={{ overflow: 'hidden' }}>
                <Each of={projectHits()} key={(hit) => hit.id}>
                  {(hit) => (
                    <SearchRow
                      testID={`search-project-${hit().id}`}
                      title={hit().name}
                      subtitle={hit().remote?.hostName ?? hit().path}
                      machine={hit().remote?.hostName}
                      query={query().trim()}
                      icon="folder"
                      onPress={() => openProject(hit())}
                    />
                  )}
                </Each>
              </Surface>
            </View>
          </If>

          <If when={sessions().length > 0}>
            <View style={{ gap: 6 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.mutedForeground(), paddingHorizontal: 4 }}>
                {t('mobile.sessions.search.section.sessions')}
              </Text>
              <Surface style={{ overflow: 'hidden' }}>
                <Each of={sessions()} key={(node) => node.id}>
                  {(node) => (
                    <SearchRow
                      testID={`search-session-${node().id}`}
                      title={node().title}
                      subtitle={node().remote ? `${node().remote!.hostName} · ${node().directory}` : node().directory}
                      snippet={snippets()[node().id]}
                      machine={node().machine}
                      query={query().trim()}
                      onPress={() => openNode(node())}
                    />
                  )}
                </Each>
              </Surface>
            </View>
          </If>

          <If when={!!query().trim() && !searching() && sessions().length === 0 && projectHits().length === 0 && !failure()}>
            <View style={{ paddingVertical: 26, gap: 6 }}>
              <Text style={{ textAlign: 'center', fontSize: 14, fontWeight: '600', color: colors.foreground() }}>
                {t('sessions.sidebar.empty.noMatches.title')}
              </Text>
              <Text style={{ textAlign: 'center', fontSize: 12, color: colors.mutedForeground() }}>
                {t('sessions.sidebar.empty.noMatches.description')}
              </Text>
            </View>
          </If>
        </View>
      </Scroll>
    </NavPage>
  );
}
