import { PanResponder, Text, View, signal, type GestureResponderEvent } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon } from '../core/Icon';
import { Highlighted, Surface, alpha, fontSize } from '../core/ui';
import type { Node, ProjectItem, WorktreeGroup } from './model';
import { remoteProblem } from './model';
import { ProjectCard, projectGlyph, projectTint, sessionCountLabel } from './ProjectCard';
import { SessionGroup } from './SessionGroup';
import type { SessionDrag } from './drag';

const groupBox = {
  borderRadius: radius.inset,
  borderWidth: 1,
  borderColor: colors.border(),
  backgroundColor: 'transparent',
} as const;

const groupsBox = { paddingHorizontal: 12, paddingTop: 2, paddingBottom: 14, gap: 10 } as const;

const rowButton = {
  flex: 1,
  minHeight: 42,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 7,
  paddingHorizontal: 10,
  paddingVertical: 6,
} as const;

const WORKTREE_ACTION = 50; // Web `--yuri-mobile-worktree-action-width` (3.125rem)
const WORKTREE_OPEN = 24;

/** Web `MobileWorktreeGroupLabel`: label row with the new-session / delete swipe rail. */
function WorktreeHeader(props: {
  group: () => WorktreeGroup;
  highlight: () => string;
  onToggle: () => void;
  onOpenActions: () => void;
  onNewSession: () => void;
  onDelete: () => void;
}) {
  const offset = signal(0);
  let start = 0;
  const pan = PanResponder.create({
    onMoveShouldSetPanResponder: (_, state) =>
      Math.abs(state.dx) > 10 && Math.abs(state.dx) > Math.abs(state.dy),
    onPanResponderGrant: () => {
      start = offset();
    },
    onPanResponderMove: (_, state) =>
      offset.set(Math.max(-WORKTREE_ACTION * 2, Math.min(0, start + state.dx))),
    onPanResponderRelease: () => offset.set(offset() < -WORKTREE_OPEN ? -WORKTREE_ACTION * 2 : 0),
    onPanResponderTerminate: () => offset.set(start),
  });
  const close = () => offset.set(0);
  return (
    <View style={{ overflow: 'hidden' }}>
      <If when={offset() < 0}>
        <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: WORKTREE_ACTION * 2, flexDirection: 'row' }}>
          <Button
            onPress={() => {
              close();
              props.onNewSession();
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: colors.muted() }}
          >
            <Icon name="add" size={18} />
            <Text style={{ fontSize: fontSize.sessionMeta, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}>
              {t('sessions.sidebar.project.actions.newSession')}
            </Text>
          </Button>
          <Button
            onPress={() => {
              close();
              props.onDelete();
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: alpha(colors.destructive(), 0.12) }}
          >
            <Icon name="delete-bin" size={18} color={() => colors.destructive()} />
            <Text style={{ fontSize: fontSize.sessionMeta, fontWeight: '500', color: colors.destructive(), numberOfLines: 1 }}>
              {t('mobile.projectEdit.deleteWorktreeTitle')}
            </Text>
          </Button>
        </View>
      </If>
      <View {...pan.panHandlers} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, transform: [{ translateX: offset() }] }}>
        <View
          testID={`worktree-${props.group().id}`}
          role="button"
          onPress={() => {
            if (offset() !== 0) {
              close();
              return;
            }
            props.onToggle();
          }}
          onLongPress={() => props.onOpenActions()}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
          style={{ ...rowButton, borderRadius: radius.inset }}
        >
          <Icon name="git-branch" size={14} tone="muted" />
          <Highlighted
            value={() => props.group().name}
            query={props.highlight}
            style={{
              flexShrink: 1,
              fontSize: fontSize.sessionGroupTitle,
              lineHeight: 16,
              fontWeight: '600',
              color: colors.foreground(),
              numberOfLines: 1,
            }}
          />
          <Text style={{ fontSize: fontSize.sessionGroupMeta, lineHeight: 14, color: colors.mutedForeground() }}>
            {sessionCountLabel(props.group().sessionCount)}
          </Text>
          <Icon name="arrow-down-s" size={14} tone="muted" />
        </View>
        <Button
          onPress={() => props.onOpenActions()}
          accessibilityLabel={t('agentManager.detail.actions.worktreeActionsAria')}
          style={{ width: 36, height: 36, marginRight: 6, alignItems: 'center', justifyContent: 'center' }}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1), borderRadius: 12 }}
        >
          <Icon name="more-2" size={14} tone="muted" />
        </Button>
      </View>
    </View>
  );
}

/** One project's floating surface: header, main workspace and its linked worktrees. */
export function ProjectSurface(props: {
  project: () => ProjectItem;
  highlight: () => string;
  onToggle: () => void;
  onOpenActions: () => void;
  onToggleWorktree: (group: WorktreeGroup) => void;
  onOpenWorktreeActions: (group: WorktreeGroup) => void;
  onNewWorktreeSession: (group: WorktreeGroup) => void;
  onDeleteWorktree: (group: WorktreeGroup) => void;
  onSelect: (node: Node) => void;
  onPin: (node: Node) => void;
  onArchive: (node: Node) => void;
  onOpenSessionActions: (node: Node) => void;
  /** Project cards reorder through the shared long-press drag. */
  drag?: SessionDrag;
  /** A hold on the project glyph drags; a hold anywhere else opens its menu. */
  startDrag?: (event: GestureResponderEvent) => boolean;
}) {
  const openActionsOnLongPress = () => !props.drag?.claimed(props.project().id);
  return (
    <View
      onTouchStartCapture={(event: GestureResponderEvent) => {
        if (props.startDrag && !props.startDrag(event)) return;
        props.drag?.start(props.project().id, event);
      }}
      onTouchMoveCapture={(event: GestureResponderEvent) => props.drag?.move(props.project().id, event)}
      onTouchEndCapture={(event: GestureResponderEvent) => props.drag?.finish(props.project().id, event)}
      onTouchCancelCapture={() => props.drag?.cancel()}
      onMoveShouldSetResponderCapture={() => props.drag?.claimed(props.project().id) ?? false}
      onResponderGrant={() => props.drag?.claimed(props.project().id) ?? false}
      onResponderMove={(event: GestureResponderEvent) => props.drag?.move(props.project().id, event)}
      onResponderRelease={(event: GestureResponderEvent) => props.drag?.finish(props.project().id, event)}
      onResponderTerminate={() => props.drag?.cancel()}
      onResponderTerminationRequest={() => !props.drag?.claimed(props.project().id)}
    >
      <Surface>
        <ProjectCard
          testID={`project-${props.project().id}`}
          model={() => ({
            name: props.project().name,
            path: props.project().path,
            icon: projectGlyph(props.project().icon),
            tint: projectTint(props.project().color),
            count: props.project().sessionCount,
            partial: props.project().sessionCountPartial,
            activity: props.project().activityLabel,
            active: props.project().active,
            expanded: props.project().expanded,
            ...(props.project().remote ? { host: props.project().remote!.hostName } : {}),
            ...(remoteProblem(props.project().remote) ? { hostProblem: remoteProblem(props.project().remote) } : {}),
          })}
          highlight={props.highlight()}
          canOpenActionsOnLongPress={openActionsOnLongPress}
          onToggle={() => {
            if (props.drag?.consumeClick(props.project().id)) return;
            props.onToggle();
          }}
          onOpenActions={props.onOpenActions}
        />
        <If when={props.project().expanded}>
          <View style={groupsBox}>
            <If
              when={
                (props.project().worktrees.find((entry) => entry.kind === 'main')?.sessions.length ?? 0) === 0 &&
                props.project().worktrees.filter((entry) => entry.kind === 'worktree').length === 0
              }
            >
              <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), paddingHorizontal: 4, paddingVertical: 10 }}>
                {t('mobile.sessions.empty.noSessionsTitle')}
              </Text>
            </If>
            <Each of={props.project().worktrees.filter((entry) => entry.kind === 'main')} key={(entry) => entry.id}>
              {(main) => (
                <If when={main().sessions.length > 0}>
                  <View style={groupBox}>
                    <SessionGroup
                      scope={main().path}
                      nodes={() => main().sessions}
                      canReorder={() => !props.project().remote && !props.highlight().trim()}
                      highlight={props.highlight}
                      onSelect={props.onSelect}
                      onPin={props.onPin}
                      onArchive={props.onArchive}
                      onOpenActions={props.onOpenSessionActions}
                    />
                  </View>
                </If>
              )}
            </Each>
            <Each of={props.project().worktrees.filter((entry) => entry.kind === 'worktree')} key={(entry) => entry.id}>
              {(tree) => (
                <View style={groupBox}>
                  <WorktreeHeader
                    group={tree}
                    highlight={props.highlight}
                    onToggle={() => props.onToggleWorktree(tree())}
                    onOpenActions={() => props.onOpenWorktreeActions(tree())}
                    onNewSession={() => props.onNewWorktreeSession(tree())}
                    onDelete={() => props.onDeleteWorktree(tree())}
                  />
                  <If when={tree().expanded && tree().sessions.length > 0}>
                    <SessionGroup
                      scope={tree().path}
                      nodes={() => tree().sessions}
                      canReorder={() => !props.project().remote && !props.highlight().trim()}
                      highlight={props.highlight}
                      onSelect={props.onSelect}
                      onPin={props.onPin}
                      onArchive={props.onArchive}
                      onOpenActions={props.onOpenSessionActions}
                    />
                  </If>
                </View>
              )}
            </Each>
          </View>
        </If>
      </Surface>
    </View>
  );
}
