import { expect, test } from 'vitest';
import { createSheetPresentation, systemSheetContentStyle, type SheetPresentation } from './sheet-presentation';

test('system container strips legacy height and keyboard margins without losing content styling', () => {
  expect(systemSheetContentStyle([{ height: 700, maxHeight: 800, marginBottom: 320, padding: 20 }, null, [{ borderRadius: 24, gap: 12 }]])).toEqual([{ padding: 20 }, null, [{ gap: 12 }]]);
});

test('system sheet waits for real dismissal before reopening and fences old completions', () => {
  let state: SheetPresentation | null = null;
  const owner = createSheetPresentation(next => { state = next; });
  owner.request(true); expect(state).toEqual({ generation: 1, phase: 'opening' });
  owner.request(false); owner.request(true);
  expect(state).toEqual({ generation: 1, phase: 'closing' });
  expect(owner.opened(1)).toBe(false);
  expect(owner.dismissed(1)).toBe(true);
  expect(state).toEqual({ generation: 2, phase: 'opening' });
  expect(owner.dismissed(1)).toBe(false);
  expect(owner.opened(2)).toBe(true);
  expect(owner.dismissed(2, true)).toBe(true);
  expect(state).toBeNull();
});

test('cancel during appearance and disposal never resurrect a controller', () => {
  const states: Array<SheetPresentation | null> = [];
  const owner = createSheetPresentation(value => states.push(value));
  owner.request(true); owner.request(false); owner.opened(1); owner.dismissed(1);
  expect(states.at(-1)).toBeNull();
  owner.request(true); owner.dispose(); owner.request(true); owner.dismissed(2);
  expect(states.at(-1)).toBeNull();
});
