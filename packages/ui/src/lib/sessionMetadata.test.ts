import { describe, expect, test } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { getSessionMetadata } from './sessionMetadata';

describe('getSessionMetadata', () => {
  test('preserves opaque metadata and Goal fields without modifying historical links', () => {
    const metadata = { goal: { text: 'Keep working' }, yuri: { kind: 'review', originalSessionID: 'old-session' } };
    const session = { metadata } as unknown as Session;
    expect(getSessionMetadata(session)).toBe(metadata);
    expect(metadata.yuri.originalSessionID).toBe('old-session');
  });

  test('treats absent and malformed metadata as an empty record', () => {
    expect(getSessionMetadata(null)).toEqual({});
    expect(getSessionMetadata(undefined)).toEqual({});
    for (const metadata of [undefined, null, [], 'invalid', 1]) {
      expect(getSessionMetadata({ metadata } as unknown as Session)).toEqual({});
    }
  });
});
