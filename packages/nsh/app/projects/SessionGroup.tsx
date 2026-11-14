import { Overlay, Text, View, effect, signal, untracked, type ViewRef } from 'nsh';
import { colors } from '../core/theme';
import { Icon } from '../core/Icon';
import { alpha, fontSize } from '../core/ui';
import { reorderSessions } from '../core/store';
import { resetBucketVisibleCounts, type Node } from './model';
import { createSessionDrag, type DragProjection } from './drag';
import { PaginationRow, SessionRow } from './SessionRow';

/**
 * One session bucket (pinned, in progress, a workspace, a worktree): flat rows
 * that swipe, open their actions and reorder by long-press drag.
 */
export function SessionGroup(props: {
  scope: string;
  nodes: () => Node[];
  canReorder?: () => boolean;
  /** Rows of the pinned / in-progress surfaces carry their own test ids. */
  idPrefix?: string;
  highlight: () => string;
  onSelect: (node: Node) => void;
  onPin: (node: Node) => void;
  onArchive: (node: Node) => void;
  onOpenActions: (node: Node) => void;
}) {
  const geometry = new Map<string, ViewRef>();
  const projection = signal<DragProjection | null>(null);
  const drag = createSessionDrag({
    ids: () => props.nodes().filter((node) => node.kind === 'session').map((node) => node.id),
    geometry,
    canDrag: () => props.canReorder?.() === true,
    onChange: (value) => projection.set(value),
    onCommit: (active, over, ids) => {
      void reorderSessions(props.scope, ids, active, over);
      resetBucketVisibleCounts();
    },
  });

  effect(() => {
    const ids = props.nodes().filter((node) => node.kind === 'session').map((node) => node.id);
    untracked(() => drag.reconcile(ids));
  });

  const dragged = () => projection()?.id ?? null;
  const draggedTitle = () => {
    const id = dragged();
    return props.nodes().find((node) => node.id === id)?.title ?? '';
  };

  return (
    <View>
      <Each of={props.nodes()} key={(node) => node.id}>
        {(node, index) => (
          <View
            ref={(ref) => {
              geometry.set(node().id, ref);
            }}
            style={{
              opacity: dragged() === node().id ? 0.3 : 1,
              translate: [0, projection()?.shifts.get(node().id) ?? 0],
              transitionProperty: 'transform',
              transitionDuration: dragged() ? 200 : 0,
            }}
          >
            <If when={node().kind === 'pagination'}>
              <PaginationRow
                node={node}
                continues={() => props.nodes()[index() + 1]?.kind === 'pagination'}
                onSelect={() => props.onSelect(node())}
              />
            </If>
            <If when={node().kind === 'session'}>
              <SessionRow
                node={node}
                divider={() => index() < props.nodes().length - 1}
                highlight={props.highlight}
                drag={drag}
                idPrefix={props.idPrefix}
                actionsOnLongPress={() => props.canReorder?.() !== true}
                onSelect={() => props.onSelect(node())}
                onPin={() => props.onPin(node())}
                onArchive={() => props.onArchive(node())}
                onOpenActions={() => props.onOpenActions(node())}
              />
            </If>
          </View>
        )}
      </Each>

      <If when={projection() !== null}>
        <Overlay
          onCancel={() => drag.cancel()}
          style={{
            position: 'absolute',
            top: projection()?.y ?? 0,
            left: projection()?.x ?? 0,
            width: projection()?.width ?? 0,
            height: projection()?.height ?? 0,
            pointerEvents: 'none',
          }}
        >
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.border(),
              backgroundColor: alpha(colors.card(), 0.96),
              paddingHorizontal: 12,
            }}
          >
            <Icon name="chat-thread" size={16} tone="muted" />
            <Text style={{ flex: 1, fontSize: fontSize.sessionTitle, color: colors.foreground(), numberOfLines: 1 }}>
              {draggedTitle()}
            </Text>
          </View>
        </Overlay>
      </If>
    </View>
  );
}
