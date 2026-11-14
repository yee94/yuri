import { Canvas, Text, View, effect, signal, untracked } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, statusColor } from '../core/theme';
import { Icon } from '../core/Icon';
import { actionMenu, alpha } from '../core/ui';
import { markRead, projectLabel, projects, worktreesFor, normalizePath } from '../core/store';
import { openNewSession } from '../shell/nav';
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
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
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

/** One session's chat page, or the new-session draft while no session exists yet. */
export function ChatPage(props: { route: ChatRoute }) {
  const route = props.route;
  const initialDirectory = normalizePath(route.directory);
  const key = route.draft || !route.sessionID ? `draft:${initialDirectory}` : `session:${route.sessionID}`;
  const conversation = conversationForRoute(key, initialDirectory, route);
  const catalog = signal(catalogFor(initialDirectory));
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
    const next = catalogFor(directory);
    if (next !== catalog()) catalog.set(next);
    void untracked(() => loadCatalog(directory)).then((loaded) => {
      if (!conversation.selection().modelID) conversation.selection.set(defaultSelection(loaded));
    });
  });

  effect(() => {
    const id = conversation.sessionID();
    if (!id) return;
    return untracked(() => {
      void markRead(id, false);
      return attachSession(conversation, id);
    });
  });

  effect(() => {
    const directory = conversation.directory();
    if (!contextOpen() && !moreOpen() && !changesOpen()) return;
    void untracked(async () => {
      const status = await readGitBranch(directory);
      branch.set(status.branch);
      dirty.set(await readDirtyChanges(directory));
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
      headerBackTitle={t('mobile.tabs.projects')}
      headerTransparent
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
      headerTitle={
        <View style={{ alignItems: 'center', gap: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.foreground(), numberOfLines: 1 }}>
            {title()}
          </Text>
          <If when={!!syncHint()}>
            <Text style={{ fontSize: 10, color: colors.mutedForeground(), numberOfLines: 1 }}>{syncHint()}</Text>
          </If>
        </View>
      }
      headerRight={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <If when={!!conversation.sessionID()}>
            <Button
              testID="chat-context"
              accessibilityLabel={t('mobile.header.openMetadataAria')}
              onPress={() => contextOpen.set(true)}
              style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}
            >
              <ContextRing percentage={percentage} />
            </Button>
          </If>
          <Button
            testID="chat-more"
            accessibilityLabel={t('mobile.menu.titleAria')}
            onPress={openMore}
            style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="more-2" size={17} />
          </Button>
        </View>
      }
    >
      <View class="flex-1" style={{ backgroundColor: colors.background() }}>
        <If
          when={!!conversation.sessionID()}
          else={<DraftBody conversation={conversation} onPickDirectory={() => void openDirectories()} />}
        >
          <Transcript conversation={conversation} />
        </If>
        <Composer conversation={conversation} catalog={catalog} onOpenPicker={openPicker} />
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
          openNewSession(conversation.directory());
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

function conversationForRoute(key: string, directory: string, route: ChatRoute) {
  return conversationFor({ key, directory, sessionID: route.sessionID, title: route.title });
}

export const chatTitle = (conversation: Conversation) => conversation.title();
