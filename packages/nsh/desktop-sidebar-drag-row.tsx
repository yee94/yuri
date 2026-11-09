import { cleanup, effect, signal, View, type JSX, type ViewProps, type ViewRef } from 'nsh';
import { desktopSidebarDragKey, type createDesktopSidebarDrag, type DesktopSidebarDragTarget } from './desktop-sidebar-drag';

export type DesktopSidebarDragRegistration = { row: DesktopSidebarDragTarget; node: ViewRef };
type DragOwner = ReturnType<typeof createDesktopSidebarDrag>;
export type DesktopSidebarDragBindings = Pick<ViewProps, 'onPressDown' | 'onPanStart' | 'onPanEnd'>;
export function desktopSidebarDragBindings(target: DesktopSidebarDragTarget | null, drag: DragOwner): DesktopSidebarDragBindings {
  return {
    onPressDown: event => { if (target) drag.arm(target, event.pagePosition); },
    onPanStart: () => { if (target) drag.begin(); },
    onPanEnd: event => { if (target) void drag.end(event.translation, event.cancelled); },
  };
}
export function DesktopSidebarDragRow(props: {
  target: DesktopSidebarDragTarget | null; label: string; children?: JSX.Element; indent?: boolean;
  selected?: boolean;
  enabled: boolean; state: { active: string | null; over: string | null }; drag: DragOwner;
  geometry: Map<string, DesktopSidebarDragRegistration>;
}) {
  const node = signal<ViewRef | null>(null);
  let registration: DesktopSidebarDragRegistration | undefined;
  const key = () => props.target ? desktopSidebarDragKey(props.target) : '';
  effect(() => {
    const target = props.target, ref = node();
    if (registration && props.geometry.get(desktopSidebarDragKey(registration.row)) === registration) props.geometry.delete(desktopSidebarDragKey(registration.row));
    registration = target && ref ? { row: target, node: ref } : undefined;
    if (registration) props.geometry.set(desktopSidebarDragKey(registration.row), registration);
  });
  cleanup(() => { if (registration && props.geometry.get(desktopSidebarDragKey(registration.row)) === registration) props.geometry.delete(desktopSidebarDragKey(registration.row)); });
  return <View {...desktopSidebarDragBindings(props.enabled ? props.target : null, props.drag)} focusable={false} ref={ref => node.set(ref)} onLayout={() => props.drag.cancel()} testID={props.target ? `desktop-drag-${props.target.kind}-${props.target.scope === '__pinned__' ? 'pinned-' : ''}${props.target.id}` : undefined} class={`group flex-row items-center min-w-0 rounded-lg ${props.selected ? 'bg-foreground/6 dark:bg-foreground/11' : 'hover:bg-foreground/3.5 dark:hover:bg-foreground/8'} ${props.state.active === key() ? 'opacity-50' : ''} ${props.state.over === key() && props.state.active !== key() ? 'bg-accent' : ''}`} style={{ minHeight: 33, marginVertical: 1 }}>
    {props.children}
  </View>;
}
export function DesktopSidebarMouseSurface(props: { drag: DragOwner; children?: JSX.Element }) {
  return <View class="flex-1 min-w-0 px-2 py-2 gap-1" onLayout={() => props.drag.cancel()} onTouchCancelCapture={() => props.drag.cancel()} onMouseMove={event => { void props.drag.move(event.pagePosition, event.pressedButton); }} onMouseLeave={() => props.drag.cancel()}>{props.children}</View>;
}
