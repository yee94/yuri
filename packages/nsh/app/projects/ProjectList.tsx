import { Overlay, Text, View, effect, signal, untracked, type ViewRef } from 'nsh';
import { colors } from '../core/theme';
import { Icon } from '../core/Icon';
import { alpha, fontSize } from '../core/ui';
import { saveProjectOrderIds } from '../core/store';
import { createSessionDrag, type DragProjection, type SessionDrag } from './drag';
import type { ProjectItem } from './model';

/**
 * Project cards reorder with the same long-press drag as session rows
 * (Web's sortable project list); the new order is kept per device and the
 * local part is also written to the Hub's catalog.
 */
export function ProjectList(props: {
  items: () => ProjectItem[];
  canReorder?: () => boolean;
  children: (project: () => ProjectItem, drag: SessionDrag, dragging: () => boolean) => unknown;
}) {
  const geometry = new Map<string, ViewRef>();
  const projection = signal<DragProjection | null>(null);
  const drag = createSessionDrag({
    ids: () => props.items().map((project) => project.id),
    geometry,
    canDrag: () => props.canReorder?.() !== false,
    onChange: (value) => projection.set(value),
    onCommit: (active, over) => {
      const ids = props.items().map((project) => project.id);
      const from = ids.indexOf(active);
      const to = ids.indexOf(over);
      if (from < 0 || to < 0 || from === to) return;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, active);
      void saveProjectOrderIds(next);
    },
  });

  effect(() => {
    const ids = props.items().map((project) => project.id);
    untracked(() => drag.reconcile(ids));
  });

  const dragged = () => projection()?.id ?? null;
  const draggedTitle = () => props.items().find((project) => project.id === dragged())?.name ?? '';

  return (
    <View>
      <Each of={props.items()} key={(project) => project.id}>
        {(project) => (
          <View
            ref={(ref) => {
              geometry.set(project().id, ref);
            }}
            style={{
              opacity: dragged() === project().id ? 0.3 : 1,
              translate: [0, projection()?.shifts.get(project().id) ?? 0],
              transitionProperty: 'transform',
              transitionDuration: dragged() ? 200 : 0,
            }}
          >
            {props.children(project, drag, () => projection() !== null) as never}
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
              borderRadius: 24,
              borderWidth: 1,
              borderColor: colors.border(),
              backgroundColor: alpha(colors.card(), 0.96),
              paddingHorizontal: 14,
            }}
          >
            <Icon name="folder" size={16} tone="muted" />
            <Text style={{ flex: 1, fontSize: fontSize.entityTitle, color: colors.foreground(), numberOfLines: 1 }}>
              {draggedTitle()}
            </Text>
          </View>
        </Overlay>
      </If>
    </View>
  );
}
