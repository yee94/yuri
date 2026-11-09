import { expect, test } from 'vitest';
import { resolveTurnOffsetTarget } from './chatTurnNavigationCore';

test('turn offsets use chronological position, clamp before the first, and resume past the tail', () => {
    const turns = ['z-first', 'a-middle', 'm-last'];
    expect(resolveTurnOffsetTarget(turns, null, -1)).toEqual({ kind: 'turn', turnId: 'a-middle' });
    expect(resolveTurnOffsetTarget(turns, 'a-middle', -1)).toEqual({ kind: 'turn', turnId: 'z-first' });
    expect(resolveTurnOffsetTarget(turns, 'z-first', -1)).toEqual({ kind: 'turn', turnId: 'z-first' });
    expect(resolveTurnOffsetTarget(turns, 'm-last', 1)).toEqual({ kind: 'resume' });
    expect(resolveTurnOffsetTarget(turns, 'missing', -1)).toEqual({ kind: 'turn', turnId: 'a-middle' });
    expect(resolveTurnOffsetTarget(turns, null, 0)).toEqual({ kind: 'noop' });
    expect(resolveTurnOffsetTarget([], null, -1)).toEqual({ kind: 'noop' });
});
