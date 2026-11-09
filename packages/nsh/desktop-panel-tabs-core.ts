import { desktopPanelScopeKey, type DesktopPanelScope, type DesktopPanelSnapshot, type DesktopPanelTab } from './desktop-panel-model';
import type { NativeDesktopPanelTabsOwner } from './desktop-panel';
import { nativeShortcutKeystroke } from './desktop-shortcuts-core';

export type DesktopPanelTabsPort = Pick<NativeDesktopPanelTabsOwner, 'snapshot' | 'select' | 'reorder' | 'requestClose'>;
export type DesktopPanelCloseAction = 'close' | 'others' | 'right' | 'all';
export type DesktopPanelCloseResult = { closed: string[]; retained: string[]; interrupted: boolean };
/** Preserve the legacy desktop-panel strip's exact icon/staged mapping. */
export function desktopPanelTabPresentation(tab: DesktopPanelTab) {
  const icon = tab.kind === 'context' ? 'pie-chart' : tab.kind === 'diff' || tab.kind === 'file-diff' ? 'file-edit' : tab.kind === 'browser' ? 'globe' : tab.kind === 'preview' ? 'eye' : tab.kind === 'chat' || tab.kind === 'btw' ? 'chat-thread' : 'file-code';
  return { icon, staged: tab.kind === 'diff' && tab.source.kind === 'workspace' && tab.source.staged === true } as const;
}
/** Reuse the existing shortcut owner's physical canonicalization (mod = Cmd on
 * Apple, Ctrl elsewhere). A native menu accelerator must never be rebound here. */
export function desktopPanelTabsKeymapAllowed(stroke: string, menuOwnedKeystrokes: readonly string[], apple: boolean): boolean {
  const physical = nativeShortcutKeystroke(stroke, apple);
  return physical !== null && !menuOwnedKeystrokes.some(owned => nativeShortcutKeystroke(owned, apple) === physical);
}
export function desktopPanelCloseTargets(value: DesktopPanelSnapshot, id: string, action: DesktopPanelCloseAction): string[] {
  const index = value.tabs.findIndex(tab => tab.id === id); if (index < 0) return [];
  return value.tabs.filter((tab, position) => action === 'all' || action === 'close' && tab.id === id || action === 'others' && tab.id !== id || action === 'right' && position > index).map(tab => tab.id);
}

/** Only interaction lifetime here; all tab state and dirty decisions belong to the
 * existing window owner. A bulk intent captures membership once and never rolls back
 * completed closes. A rejected/thrown guard retains that tab and proceeds sequentially. */
export function createDesktopPanelTabsInteraction(input: { tabs: DesktopPanelTabsPort; scope: () => DesktopPanelScope; current: () => boolean; busy?: (busy: boolean) => void }) {
  let alive = true, flight: Promise<DesktopPanelCloseResult> | undefined;
  const captured = () => { const scope = input.scope(); return { ...scope, host: { ...scope.host } }; };
  const valid = (scope: DesktopPanelScope) => alive && input.current() && desktopPanelScopeKey(scope) === desktopPanelScopeKey(input.scope()) && scope.host.lease === input.scope().host.lease;
  function close(id: string, action: DesktopPanelCloseAction = 'close'): Promise<DesktopPanelCloseResult> {
    if (flight) return flight;
    const scope = captured(), result: DesktopPanelCloseResult = { closed: [], retained: [], interrupted: false };
    if (!valid(scope)) return Promise.resolve({ ...result, interrupted: true });
    const ids = desktopPanelCloseTargets(input.tabs.snapshot(scope), id, action);
    input.busy?.(true);
    flight = Promise.resolve().then(async () => {
      for (let index = 0; index < ids.length; index++) {
        if (!valid(scope)) { result.interrupted = true; result.retained.push(...ids.slice(index)); break; }
        const tabID = ids[index];
        try {
          const closed = await input.tabs.requestClose(scope, tabID);
          (closed ? result.closed : result.retained).push(tabID);
        } catch { result.retained.push(tabID); }
      }
      return result;
    }).finally(() => { flight = undefined; if (alive) input.busy?.(false); });
    return flight;
  }
  return {
    select(id: string) { const scope = captured(); if (!valid(scope) || flight) return false; input.tabs.select(scope, id); return true; },
    reorder(active: string, over: string) { const scope = captured(); return valid(scope) && !flight && input.tabs.reorder(scope, active, over); },
    navigate(direction: 'previous' | 'next' | 'first' | 'last', reorder = false) {
      const scope = captured(); if (!valid(scope) || flight) return;
      const value = input.tabs.snapshot(scope), index = value.tabs.findIndex(tab => tab.id === value.selectedID), count = value.tabs.length;
      if (!count) return;
      const next = direction === 'first' ? 0 : direction === 'last' ? count - 1 : reorder
        ? Math.min(count - 1, Math.max(0, index + (direction === 'next' ? 1 : -1)))
        : (Math.max(0, index) + (direction === 'next' ? 1 : count - 1)) % count;
      const target = value.tabs[next].id;
      if (reorder && value.selectedID) input.tabs.reorder(scope, value.selectedID, target); else input.tabs.select(scope, target);
    },
    close,
    /** Native integration port only; NSH 0.4 View exposes no middle-click event. */
    pointerClose(id: string, button: string) { if (button === 'middle') return close(id); },
    dispose() { alive = false; },
  };
}

export type DesktopPanelTabRect = { x: number; y: number; width: number; height: number };
/** Native geometry only; measured once per gesture, not on every pointer move. */
export function createDesktopPanelTabDrag(input: {
  current: () => boolean; generation: () => string; ids: () => readonly string[];
  measure: (id: string) => Promise<DesktopPanelTabRect | null>;
  changed: (state: { active: string | null; over: string | null }) => void;
  reorder: (active: string, over: string) => unknown;
}) {
  let serial = 0;
  let gesture: { serial: number; generation: string; ids: readonly string[]; id: string; origin: { x: number; y: number }; started: boolean; geometry: Promise<Array<{ id: string; rect: DesktopPanelTabRect }>> } | undefined;
  const valid = (value: NonNullable<typeof gesture>) => {
    if (gesture !== value || value.serial !== serial || value.generation !== input.generation() || !input.current()) return false;
    const ids = input.ids(); return value.ids.length === ids.length && value.ids.every((id, index) => id === ids[index]);
  };
  function cancel() { serial++; gesture = undefined; input.changed({ active: null, over: null }); }
  function pick(rows: Array<{ id: string; rect: DesktopPanelTabRect }>, point: { x: number; y: number }) {
    return rows.find(({ rect }) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height)?.id ?? null;
  }
  return {
    arm(id: string, origin: { x: number; y: number }) {
      cancel(); if (!input.current()) return;
      const ids = [...input.ids()], ticket = serial, generation = input.generation(); if (!ids.includes(id)) return;
      const geometry = (async () => {
        const rows: Array<{ id: string; rect: DesktopPanelTabRect }> = [];
        for (let index = 0; index < ids.length; index += 2) {
          if (ticket !== serial || !input.current() || generation !== input.generation()) return [];
          for (const row of await Promise.all(ids.slice(index, index + 2).map(async id => ({ id, rect: await input.measure(id) })))) if (row.rect && row.rect.width > 0 && row.rect.height > 0) rows.push({ id: row.id, rect: row.rect });
        }
        return rows;
      })().catch(() => []);
      gesture = { serial: ticket, generation, ids, id, origin, started: false, geometry };
    },
    begin() { if (gesture && valid(gesture)) { gesture.started = true; input.changed({ active: gesture.id, over: null }); } },
    async move(point: { x: number; y: number }, button: string | null) {
      const value = gesture; if (!value?.started || !valid(value)) return;
      if (button !== 'left') { cancel(); return; }
      const rows = await value.geometry; if (valid(value)) input.changed({ active: value.id, over: pick(rows, point) });
    },
    async end(translation: { x: number; y: number }, cancelled: boolean) {
      const value = gesture; if (!value?.started || cancelled || !valid(value)) { cancel(); return; }
      const rows = await value.geometry; if (!valid(value)) return;
      const over = pick(rows, { x: value.origin.x + translation.x, y: value.origin.y + translation.y }); cancel();
      if (over && over !== value.id) input.reorder(value.id, over);
    }, cancel,
  };
}
