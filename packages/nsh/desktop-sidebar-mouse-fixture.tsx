import { cleanup, mount, signal, Text, View } from 'nsh';
import { createDesktopSidebarDrag, desktopSidebarDragKey } from './desktop-sidebar-drag';
import { DesktopSidebarDragRow, DesktopSidebarMouseSurface, type DesktopSidebarDragRegistration } from './desktop-sidebar-drag-row';

// In-memory only: the production mouse surface/row adapter, no Host or repository access.
function Fixture() {
  const rows = signal(['z', 'a', 'b']), moves = signal(0);
  const state = signal<{ active: string | null; over: string | null }>({ active: null, over: null });
  const geometry = new Map<string, DesktopSidebarDragRegistration>();
  const drag = createDesktopSidebarDrag({ current: () => true, generation: () => 'synthetic-mouse', targets: () => [...geometry.values()].map(value => value.row),
    measure: async target => {
      const value = await geometry.get(desktopSidebarDragKey(target))?.node.measure();
      return value ? { left: value.pagePosition.x, top: value.pagePosition.y, width: value.bounds.size.width, height: value.bounds.size.height } : null;
    },
    changed: value => { state.set(value); if (value.over) moves.set(moves() + 1); },
    commit: intent => { const next = [...rows()], from = next.indexOf(intent.active), to = next.indexOf(intent.over); const [moved] = next.splice(from, 1); next.splice(to, 0, moved!); rows.set(next); },
  });
  cleanup(() => drag.cancel());
  return <View class="flex-1"><View style={{ width: 260, height: 200 }}><DesktopSidebarMouseSurface drag={drag}>
    <Each of={rows()} key={id => id}>{id => <DesktopSidebarDragRow target={{ kind: 'session', scope: '/synthetic', id: id() }} label={id()} enabled state={state()} drag={drag} geometry={geometry}><Text class="flex-1" style={{ height: 30 }}>{id()}</Text></DesktopSidebarDragRow>}</Each>
  </DesktopSidebarMouseSurface></View><Text>{`order:${rows().join(',')}`}</Text><Text>{`mouse-moves:${moves()}`}</Text></View>;
}
mount(Fixture);
