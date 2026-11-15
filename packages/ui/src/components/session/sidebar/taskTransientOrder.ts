/**
 * Drag order for the task view's active list. It lives only in memory and is
 * advisory: it re-ranks rows the user moved, but the first time a moved row's
 * state changes (activity advances, it starts running, or it starts waiting on
 * the user) its place is forgotten and the normal ranking applies again.
 */
export type TransientRowState = {
  activityAt: number;
  running: boolean;
  attention: boolean;
};

export type TransientOrder = {
  ids: readonly string[];
  /** State of every listed row at the moment the user dropped it. */
  baseline: Readonly<Record<string, TransientRowState>>;
};

export const EMPTY_TRANSIENT_ORDER: TransientOrder = { ids: [], baseline: {} };

const sameState = (left: TransientRowState | undefined, right: TransientRowState | undefined): boolean => (
  left !== undefined
  && right !== undefined
  && left.activityAt === right.activityAt
  && left.running === right.running
  && left.attention === right.attention
);

/**
 * Rows of `ranked` (already in the normal order) rearranged by the drag order.
 * Rows whose state moved since the drop, or that the drag order never saw, stay
 * where the normal ranking put them; the rest fill the remaining slots in the
 * dragged order. Returns `ranked` itself when nothing is moved.
 */
export const applyTransientOrder = <T>(
  ranked: readonly T[],
  getId: (item: T) => string,
  getState: (item: T) => TransientRowState,
  order: TransientOrder,
): readonly T[] => {
  if (order.ids.length === 0) return ranked;

  const byId = new Map<string, T>();
  for (const item of ranked) byId.set(getId(item), item);

  const held: T[] = [];
  const heldIds = new Set<string>();
  for (const id of order.ids) {
    const item = byId.get(id);
    if (!item || heldIds.has(id) || !sameState(order.baseline[id], getState(item))) continue;
    held.push(item);
    heldIds.add(id);
  }
  if (held.length < 2) return ranked;

  let next = 0;
  const result = ranked.map((item) => (heldIds.has(getId(item)) ? held[next++] : item));
  return result.every((item, index) => item === ranked[index]) ? ranked : result;
};

/**
 * Drag order after moving `activeId` onto `overId` in `visible` (the order on
 * screen). Records a baseline for every visible row so later state changes can
 * be told apart from the drag itself.
 */
export const moveInTransientOrder = (
  visible: readonly string[],
  activeId: string,
  overId: string,
  getState: (id: string) => TransientRowState | undefined,
): TransientOrder | null => {
  const from = visible.indexOf(activeId);
  const to = visible.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const ids = [...visible];
  ids.splice(from, 1);
  ids.splice(to, 0, activeId);
  const baseline: Record<string, TransientRowState> = {};
  for (const id of ids) {
    const state = getState(id);
    if (state) baseline[id] = state;
  }
  return { ids, baseline };
};
