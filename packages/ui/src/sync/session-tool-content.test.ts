import { expect, test } from 'vitest';
import { projectionToolOutput, projectionToolTime } from './session-tool-content';

test('official content wins over legacy output; only actual text leaves become output', () => {
  expect(projectionToolOutput({ output: 'legacy' })).toBe('legacy');
  expect(projectionToolOutput({ content: [], output: 'stale' })).toBe('');
  expect(projectionToolOutput({ content: [{ type: 'text', text: 'a' }, null, { type: 'image', text: 'not text' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
  expect(projectionToolOutput({})).toBeUndefined();
});

test('tool clocks retain zero and finite native authority without converting absent or invalid values', () => {
  expect(projectionToolTime({ ran: 0, completed: 11400 })).toEqual({ start: 0, end: 11400 });
  for (const value of [null, undefined, [], { ran: NaN, completed: Infinity }, { ran: '1', completed: false }]) expect(projectionToolTime(value)).toEqual({});
});
