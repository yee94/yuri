import { describe, expect, test } from 'vitest';

import {
  EMPTY_TRANSIENT_ORDER,
  applyTransientOrder,
  moveInTransientOrder,
  type TransientRowState,
} from './taskTransientOrder';

type Row = { id: string } & TransientRowState;

const row = (id: string, extra: Partial<TransientRowState> = {}): Row => ({
  id,
  activityAt: 1,
  running: false,
  attention: false,
  ...extra,
});

const apply = (ranked: Row[], order: Parameters<typeof applyTransientOrder<Row>>[3]) => (
  applyTransientOrder(ranked, (item) => item.id, (item) => item, order).map((item) => item.id)
);

const stateOf = (rows: Row[]) => (id: string) => rows.find((item) => item.id === id);

describe('task transient order', () => {
  test('no drag order leaves the ranked list untouched and returns the same array', () => {
    const ranked = [row('a'), row('b')];
    expect(applyTransientOrder(ranked, (item) => item.id, (item) => item, EMPTY_TRANSIENT_ORDER)).toBe(ranked);
  });

  test('a drop moves the row and keeps everything else in place', () => {
    const rows = [row('a'), row('b'), row('c'), row('d')];
    const order = moveInTransientOrder(['a', 'b', 'c', 'd'], 'a', 'c', stateOf(rows))!;
    expect(order.ids).toEqual(['b', 'c', 'a', 'd']);
    expect(apply(rows, order)).toEqual(['b', 'c', 'a', 'd']);
  });

  test('a moved row whose activity advanced returns to its normal slot', () => {
    const rows = [row('a'), row('b'), row('c')];
    // Drag a below c: the dragged order is b, c, a.
    const order = moveInTransientOrder(['a', 'b', 'c'], 'a', 'c', stateOf(rows))!;
    // a gets new activity, so the normal ranking puts it first. a is released,
    // and b/c stay where the normal ranking has them.
    const after = [row('a', { activityAt: 9 }), row('b'), row('c')];
    expect(apply(after, order)).toEqual(['a', 'b', 'c']);
  });

  test('a row that starts running or waiting is released from the drag order', () => {
    const rows = [row('a'), row('b'), row('c')];
    const order = moveInTransientOrder(['a', 'b', 'c'], 'a', 'c', stateOf(rows))!;
    // b starts running and ranks first; only c and a are still held, and they
    // fill the slots the normal ranking left to them, in dragged order (c, a).
    const running = [row('b', { running: true }), row('a'), row('c')];
    expect(apply(running, order)).toEqual(['b', 'c', 'a']);
    const waiting = [row('b', { attention: true }), row('a'), row('c')];
    expect(apply(waiting, order)).toEqual(['b', 'c', 'a']);
  });

  test('rows the drag never saw and rows that left the list do not break the order', () => {
    const rows = [row('a'), row('b'), row('c')];
    const order = moveInTransientOrder(['a', 'b', 'c'], 'a', 'c', stateOf(rows))!;
    const changed = [row('new'), row('b'), row('c')];
    const result = apply(changed, order);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('new');
    expect(new Set(result)).toEqual(new Set(['new', 'b', 'c']));
  });

  test('dropping on itself or an unknown row records nothing', () => {
    const rows = [row('a'), row('b')];
    expect(moveInTransientOrder(['a', 'b'], 'a', 'a', stateOf(rows))).toBeNull();
    expect(moveInTransientOrder(['a', 'b'], 'a', 'zz', stateOf(rows))).toBeNull();
  });

  test('a result equal to the ranked order returns the same array', () => {
    const rows = [row('a'), row('b')];
    const order = moveInTransientOrder(['a', 'b'], 'b', 'a', stateOf(rows))!;
    const reversedBack = [row('b'), row('a')];
    expect(applyTransientOrder(reversedBack, (item) => item.id, (item) => item, { ...order, baseline: { a: reversedBack[1], b: reversedBack[0] } })).toBe(reversedBack);
  });
});
