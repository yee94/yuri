import { Text, View, type GestureResponderEvent } from 'nsh';
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

/** One project's floating surface: header, main workspace and its linked worktrees. */
export function ProjectSurface(props: {
  project: () => ProjectItem;
  highlight: () => string;
  onToggle: () => void;
  onOpenActions: () => void;
  onToggleWorktree: (group: WorktreeGroup) => void;
  onOpenWorktreeActions: (group: WorktreeGroup) => void;
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
            <If when={props.project().worktrees.every((entry) => entry.sessions.length === 0)}>
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
                      canReorder={() => !props.project().remote}
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
                  <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 42, paddingRight: 4 }}>
                    <View
                      testID={`worktree-${tree().id}`}
                      role="button"
                      onPress={() => props.onToggleWorktree(tree())}
                      onLongPress={() => props.onOpenWorktreeActions(tree())}
                      activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
                      style={rowButton}
                    >
                      <Icon name="git-branch" size={14} tone="muted" />
                      <Highlighted
                        value={() => tree().name}
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
                        {sessionCountLabel(tree().sessionCount)}
                      </Text>
                      <Icon name={() => (tree().expanded ? 'arrow-down-s' : 'arrow-right-s')} size={14} tone="muted" />
                    </View>
                    <Button
                      onPress={() => props.onOpenWorktreeActions(tree())}
                      accessibilityLabel={t('agentManager.detail.actions.worktreeActionsAria')}
                      style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}
                      activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1), borderRadius: 12 }}
                    >
                      <Icon name="more-2" size={14} tone="muted" />
                    </Button>
                  </View>
                  <If when={tree().expanded && tree().sessions.length > 0}>
                    <SessionGroup
                      scope={tree().path}
                      nodes={() => tree().sessions}
                      canReorder={() => !props.project().remote}
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
