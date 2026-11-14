import { Canvas, Text, View, effect, signal, untracked } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, statusColor } from '../core/theme';
import { Icon } from '../core/Icon';
import { actionMenu, alpha } from '../core/ui';
import { markRead, projectLabel, projects, worktreesFor, normalizePath } from '../core/store';
import { remoteSessionIDFrom } from '../core/remote';
import { activeStack, openNewSession } from '../shell/nav';
import type { ChatRoute } from '../shell/nav';
import { Composer } from './Composer';
import { PickerSheet, ContextSheet } from './Sheets';
import { ChangesSheet } from './ChangesSheet';
import { McpSheet } from './McpSheet';
import { TimelineSheet } from './TimelineSheet';
import { ChildSessionsSheet } from './ChildSessionsSheet';
import { MoreSheet } from './MoreSheet';
import { Transcript } from './Transcript';
import {
  attachSession,
  catalogFor,
  contextUsage,
  conversationFor,
  defaultSelection,
  loadCatalog,
  loadMessages,
  modelEntries,
  moveDraft,
  readDirtyChanges,
  readGitBranch,
  sameModel,
  type Conversation,
} from './store';

function usageColor(percentage: number): string {
  if (percentage >= 90) return colors.destructive();
  if (percentage >= 75) return statusColor('warning');
  return colors.success();
}

function ContextRing(props: { percentage: () => number }) {
  return (
    <Canvas
      style={{ width: 20, height: 20 }}
      draw={(ctx, size) => {
        const radius = Math.min(size.width, size.height) / 2 - 1.6;
        const cx = size.width / 2;
        const cy = size.height / 2;
        ctx.clearRect(0, 0, size.width, size.height);
        ctx.lineWidth = 2;
        ctx.strokeStyle = alpha(colors.mutedForeground(), 0.25);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
        const value = Math.min(Math.max(props.percentage(), 0), 100);
        if (value <= 0) return;
        ctx.strokeStyle = usageColor(props.percentage());
        ctx.beginPath();
        ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * value) / 100);
        ctx.stroke();
      }}
    />
  );
}

function DraftBody(props: { conversation: Conversation; onPickDirectory: () => void }) {
  const directory = () => props.conversation.directory();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        paddingTop: 'env(safe-area-inset-top)',
      }}
    >
      <Text style={{ fontSize: 28, lineHeight: 34, fontWeight: '400', color: colors.foreground(), textAlign: 'center' }}>
        {t('chat.emptyState.draftTitleWithProject', { project: projectLabel(directory()) })}
      </Text>
      <Button
        testID="chat-draft-directory"
        onPress={props.onPickDirectory}
        style={{
          marginTop: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 14,
          backgroundColor: alpha(colors.muted(), 0.6),
        }}
      >
        <Icon name="folder" size={13} tone="muted" />
        <Text style={{ fontSize: 12, color: colors.mutedForeground(), numberOfLines: 1 }}>{directory()}</Text>
        <Icon name="arrow-down-s" size={11} tone="muted" />
      </Button>
    </View>
  );
}

/** Web `MobileDetailNavigation`: the chat header is a glass overlay that leaves
 * upward and fades as the reader moves into history, restored at the live edge. */
function ChatHeader(props: {
  title: () => string;
  hint: () => string;
  session: () => boolean;
  progress: () => number;
  percentage: () => number;
  onBack: () => void;
  onContext: () => void;
  onMore: () => void;
}) {
  const shift = () => props.progress() * 64;
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 30,
        paddingTop: 'env(safe-area-inset-top)',
        transform: props.progress() > 0.001 ? `translateY(${-shift()}px)` : 'none',
        opacity: 1 - props.progress(),
        backgroundColor: alpha(colors.background(), 0.82),
        backdropFilter: 'blur(20px) saturate(1.25)',
        glassEffect: 'regular',
        borderBottomWidth: 0.5,
        borderBottomColor: alpha(colors.border(), 0.5),
      }}
    >
      <View style={{ height: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}>
        <Button
          testID="chat-back"
          accessibilityLabel={t('header.actions.backAria')}
          onPress={props.onBack}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1) }}
          style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="arrow-left" size={18} />
        </Button>
        <View style={{ flex: 1, alignItems: 'center', gap: 1, paddingHorizontal: 4 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.foreground(), numberOfLines: 1 }}>
            {props.title()}
          </Text>
          <If when={!!props.hint()}>
            <Text style={{ fontSize: 10, color: colors.mutedForeground(), numberOfLines: 1 }}>{props.hint()}</Text>
          </If>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <If when={props.session()}>
            <Button
              testID="chat-context"
              accessibilityLabel={t('mobile.header.openMetadataAria')}
              onPress={props.onContext}
              activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1) }}
              style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }}
            >
              <ContextRing percentage={props.percentage} />
            </Button>
          </If>
          <Button
            testID="chat-more"
            accessibilityLabel={t('mobile.menu.titleAria')}
            onPress={props.onMore}
            activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1) }}
            style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="more-2" size={17} />
          </Button>
        </View>
      </View>
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: -18,
          height: 18,
          backgroundImage: `linear-gradient(to bottom, ${alpha(colors.background(), 0.82)}, ${alpha(colors.background(), 0)})`,
        }}
      />
    </View>
  );
}

/** One session's chat page, or the new-session draft while no session exists yet. */
export function ChatPage(props: { route: ChatRoute }) {
  const route = props.route;
  const initialDirectory = normalizePath(route.directory);
  // The phone row key carries its machine; the Host's session id is what the
  // proxied routes and transcript windows address (Web `remoteSession.sessionId`).
  const sessionID = route.remote && route.sessionID
    ? remoteSessionIDFrom(route.remote.hostId, route.sessionID)
    : route.sessionID;
  const scope = route.remote ? `remote:${route.remote.hostId}:` : '';
  const key = route.draft || !sessionID ? `${scope}draft:${initialDirectory}` : `${scope}session:${sessionID}`;
  const conversation = conversationForRoute(key, initialDirectory, route, sessionID);
  const hostId = conversation.hostId;
  const catalog = signal(catalogFor(initialDirectory, hostId));
  const pickerOpen = signal(false);
  const pickerTab = signal<'model' | 'agent'>('model');
  const contextOpen = signal(false);
  const moreOpen = signal(false);
  const changesOpen = signal(false);
  const mcpOpen = signal(false);
  const timelineOpen = signal(false);
  const childrenOpen = signal(false);
  const branch = signal('');
  const dirty = signal(0);
  // 0 = full header/composer, 1 = compact composer pill (Web composer swap).
  const chrome = signal(0);
  const latest = signal(0);

  const title = () => {
    if (!conversation.sessionID()) return t('mobile.menu.newSession');
    return conversation.title() || route.title || t('mobile.sessions.untitled');
  };
  const syncHint = () => {
    if (conversation.error() && conversation.messages().length === 0) return '';
    if (conversation.loading() && conversation.messages().length === 0) return t('mobile.chat.syncingMessages');
    if (conversation.stream() === 'connecting' && conversation.messages().length > 0) return t('mobile.chat.syncingMessages');
    if (conversation.stream() === 'disconnected') return t('mobile.chat.syncingMessages');
    return '';
  };
  const limit = () => {
    const selection = conversation.selection();
    const entry = modelEntries(catalog()).find((candidate) => sameModel(candidate, selection));
    const raw = (entry?.model.limit ?? {}) as { context?: unknown };
    return typeof raw.context === 'number' && Number.isFinite(raw.context) && raw.context > 0 ? raw.context : 0;
  };
  const percentage = () => {
    // One list subscription, not one per message part: the baseline scan stays off the render path.
    if (conversation.messages().length === 0) return 0;
    const total = untracked(() => contextUsage(conversation).tokens);
    const max = limit();
    if (total === null || !max) return 0;
    return Math.min((total / max) * 100, 100);
  };

  effect(() => {
    const directory = conversation.directory();
    const next = catalogFor(directory, hostId);
    if (next !== catalog()) catalog.set(next);
    void untracked(() => loadCatalog(directory, hostId)).then((loaded) => {
      if (!conversation.selection().modelID) conversation.selection.set(defaultSelection(loaded));
    });
  });

  effect(() => {
    const id = conversation.sessionID();
    if (!id) return;
    return untracked(() => {
      // The remote row already cleared its Host unread before opening (Web phone).
      if (!conversation.hostId) void markRead(id, false);
      return attachSession(conversation, id);
    });
  });

  effect(() => {
    const directory = conversation.directory();
    if (!contextOpen() && !moreOpen() && !changesOpen()) return;
    void untracked(async () => {
      const status = await readGitBranch(directory, hostId);
      branch.set(status.branch);
      dirty.set(await readDirtyChanges(directory, hostId));
    });
  });

  const openPicker = (tab: 'model' | 'agent') => {
    pickerTab.set(tab);
    pickerOpen.set(true);
  };

  const openMore = () => moreOpen.set(true);

  const openDirectories = async () => {
    const options: { id: string; label: string; path: string }[] = [];
    for (const project of projects()) {
      options.push({ id: `p:${project.id}`, label: project.label, path: project.path });
      for (const tree of worktreesFor(project.path)) options.push({ id: `w:${tree.path}`, label: `${project.label} · ${tree.name}`, path: tree.path });
    }
    const choice = await actionMenu({
      title: t('mobile.header.metadata.branch'),
      actions: options.map((option) => ({ id: option.id, label: `${option.label} — ${option.path}` })),
    });
    const picked = options.find((option) => option.id === choice);
    if (picked) void moveDraft(conversation, picked.path);
  };

  return (
    <NavPage
      testID="chat-page"
      title={title()}
      headerVisible={false}
      headerTransparent
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
    >
      <View class="flex-1" style={{ backgroundColor: colors.background() }}>
        <ChatHeader
          title={title}
          hint={syncHint}
          session={() => !!conversation.sessionID()}
          progress={() => chrome()}
          percentage={percentage}
          onBack={() => activeStack().pop()}
          onContext={() => contextOpen.set(true)}
          onMore={openMore}
        />
        <If
          when={!!conversation.sessionID()}
          else={<DraftBody conversation={conversation} onPickDirectory={() => void openDirectories()} />}
        >
          <Transcript
            conversation={conversation}
            catalog={catalog}
            chrome={chrome}
            latest={() => latest()}
          />
        </If>
        <Composer
          conversation={conversation}
          catalog={catalog}
          onOpenPicker={openPicker}
          progress={() => chrome()}
          onExpand={() => {
            chrome.set(0);
            latest.set(latest() + 1);
          }}
        />
      </View>
      <PickerSheet
        conversation={conversation}
        catalog={catalog}
        open={pickerOpen}
        close={() => pickerOpen.set(false)}
        tab={pickerTab}
        setTab={(tab) => pickerTab.set(tab)}
      />
      <ContextSheet
        conversation={conversation}
        open={contextOpen}
        close={() => contextOpen.set(false)}
        branch={branch}
        limit={limit}
      />
      <MoreSheet
        conversation={conversation}
        open={moreOpen}
        close={() => moreOpen.set(false)}
        dirtyChanges={dirty}
        onNew={() => {
          moreOpen.set(false);
          openNewSession(conversation.directory(), conversation.remote ?? undefined);
        }}
        onChanges={() => {
          moreOpen.set(false);
          changesOpen.set(true);
        }}
        onMcp={() => {
          moreOpen.set(false);
          mcpOpen.set(true);
        }}
        onTimeline={() => {
          moreOpen.set(false);
          timelineOpen.set(true);
        }}
        onChildren={() => {
          moreOpen.set(false);
          childrenOpen.set(true);
        }}
        onSync={() => {
          moreOpen.set(false);
          void loadMessages(conversation);
        }}
      />
      <ChangesSheet conversation={conversation} open={changesOpen} close={() => changesOpen.set(false)} />
      <McpSheet conversation={conversation} open={mcpOpen} close={() => mcpOpen.set(false)} />
      <TimelineSheet conversation={conversation} open={timelineOpen} close={() => timelineOpen.set(false)} />
      <ChildSessionsSheet conversation={conversation} open={childrenOpen} close={() => childrenOpen.set(false)} />
    </NavPage>
  );
}

function conversationForRoute(key: string, directory: string, route: ChatRoute, sessionID: string | null) {
  return conversationFor({
    key,
    directory,
    sessionID,
    title: route.title,
    remote: route.remote ?? null,
  });
}

export const chatTitle = (conversation: Conversation) => conversation.title();
