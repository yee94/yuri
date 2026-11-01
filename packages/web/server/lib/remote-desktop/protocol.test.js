import { expect, it } from 'vitest';
import { parseDesktopMessage } from './protocol.js';

it.each([null, [], {}, { type: 'exec', command: 'something' }, { type: 'text', text: 'x'.repeat(1025) },
  { type: 'key', key: 'arbitrary' }, { type: 'pointer', action: 'down', x: NaN, y: 0 },
  { type: 'pointer', action: 'click', x: 2, y: 0 }, { type: 'scroll', dx: Infinity, dy: 0 },
  { type: 'answer', sdp: 'x'.repeat(65537) }, { type: 'ice', candidate: { candidate: 'x'.repeat(2049) } },
])('rejects invalid or oversized messages %#', value => {
  expect(() => parseDesktopMessage(value)).toThrow('invalid_message');
});
it('projects only permitted fields and bounds scroll and input', () => {
  expect(parseDesktopMessage({ type: 'pointer', action: 'down', x: 0.2, y: 0.7, command: 'ignored' })).toEqual({ type: 'pointer', action: 'down', x: 0.2, y: 0.7 });
  expect(parseDesktopMessage({ type: 'scroll', dx: -2000, dy: 5000 })).toEqual({ type: 'scroll', dx: -1000, dy: 1000 });
  expect(parseDesktopMessage({ type: 'text', text: '中文🙂' })).toEqual({ type: 'text', text: '中文🙂' });
  expect(parseDesktopMessage({ type: 'ice', candidate: { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0, unexpected: 'ignored' } })).toEqual({
    type: 'ice', candidate: { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 },
  });
});
