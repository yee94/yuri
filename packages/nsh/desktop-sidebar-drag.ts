import type { DesktopSidebarOrderIntent } from './desktop-sidebar-order';

export type DesktopSidebarDragTarget = { kind: 'session' | 'worktree' | 'project' | 'folder'; scope: string; id: string; folderId?: string | null; parentId?: string | null };
export type DesktopSidebarDragRect = { left: number; top: number; width: number; height: number };
export const desktopSidebarDragKey = (row: DesktopSidebarDragTarget) => JSON.stringify([row.kind, row.scope, row.id]);
const compatible = (a: DesktopSidebarDragTarget, b: DesktopSidebarDragTarget) => a.scope === b.scope && (
  a.kind === 'session' ? b.kind === 'folder' || b.kind === 'session' && (a.folderId ?? null) === (b.folderId ?? null)
    : a.kind === b.kind && (a.kind !== 'folder' || (a.parentId ?? null) === (b.parentId ?? null))
);

/** Desktop native-pan owner. macOS input.rs explicitly sends mouse drags to pans,
 * never to content scrolling. MouseMove.pressedButton supplies live feedback; PanEnd
 * supplies the actual release translation, including when no final move was delivered.
 * The surface also forwards pointer cancellation: macOS input.rs reports TouchCancel
 * before PanEnd, but its Pan payload does not distinguish cancelled from released.
 * This is not Projects' touch/PanResponder recognizer. */
export function createDesktopSidebarDrag(input: {
  current: () => boolean; generation: () => string;
  targets: () => readonly DesktopSidebarDragTarget[];
  measure: (target: DesktopSidebarDragTarget) => Promise<DesktopSidebarDragRect | null>;
  changed: (state: { active: string | null; over: string | null }) => void;
  commit: (intent: DesktopSidebarOrderIntent) => void;
}) {
  let serial = 0;
  let gesture: { serial: number; generation: string; source: DesktopSidebarDragTarget; origin: { x: number; y: number }; started: boolean; geometry: Promise<Array<{ row: DesktopSidebarDragTarget; rect: DesktopSidebarDragRect }>> } | undefined;
  const valid = (value: NonNullable<typeof gesture>) => gesture === value && value.serial === serial && value.generation === input.generation() && input.current();
  function cancel() { serial++; gesture = undefined; input.changed({ active: null, over: null }); }
  function pick(rows: Array<{ row: DesktopSidebarDragTarget; rect: DesktopSidebarDragRect }>, point: { x: number; y: number }) {
    return rows.find(({ rect }) => point.x >= rect.left && point.x <= rect.left + rect.width && point.y >= rect.top && point.y <= rect.top + rect.height)?.row;
  }
  return {
    arm(source: DesktopSidebarDragTarget, origin: { x: number; y: number }) {
      cancel(); if (!input.current()) return;
      const revision = serial, generation = input.generation();
      const candidates = input.targets().filter(row => compatible(source, row));
      if (!candidates.some(row => desktopSidebarDragKey(row) === desktopSidebarDragKey(source))) return;
      const geometry = (async () => {
        const rows: Array<{ row: DesktopSidebarDragTarget; rect: DesktopSidebarDragRect }> = [];
        for (let index = 0; index < candidates.length; index += 2) {
          if (revision !== serial || generation !== input.generation() || !input.current()) return [];
          const next = await Promise.all(candidates.slice(index, index + 2).map(async row => {
            const rect = await input.measure(row); return rect && rect.width > 0 && rect.height > 0 ? { row, rect } : null;
          }));
          for (const row of next) if (row) rows.push(row);
        }
        return rows;
      })().catch(() => []);
      gesture = { serial: revision, generation, source, origin, started: false, geometry };
    },
    begin() { const value = gesture; if (value && valid(value)) { value.started = true; input.changed({ active: desktopSidebarDragKey(value.source), over: null }); } },
    async move(point: { x: number; y: number }, pressedButton: string | null) {
      const value = gesture; if (!value?.started || !valid(value)) return;
      if (pressedButton !== 'left') { cancel(); return; }
      const rows = await value.geometry; if (!valid(value)) return;
      const over = pick(rows, point);
      input.changed({ active: desktopSidebarDragKey(value.source), over: over ? desktopSidebarDragKey(over) : null });
    },
    async end(translation: { x: number; y: number }, cancelled: boolean) {
      const value = gesture;
      if (!value?.started || cancelled || !valid(value)) { cancel(); return; }
      const rows = await value.geometry;
      if (!valid(value)) return;
      const over = pick(rows, { x: value.origin.x + translation.x, y: value.origin.y + translation.y });
      const eligible = input.targets().some(row => over && desktopSidebarDragKey(row) === desktopSidebarDragKey(over));
      cancel();
      if (over && eligible && (over.id !== value.source.id || over.kind !== value.source.kind)) input.commit({ kind: value.source.kind, scope: value.source.scope, active: value.source.id, over: over.id, ...(over.kind !== value.source.kind ? { targetKind: over.kind } : {}) });
    }, cancel,
  };
}
