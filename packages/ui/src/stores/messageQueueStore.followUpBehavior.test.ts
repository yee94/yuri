import { describe, expect, it } from 'vitest';
import * as behavior from '@/lib/followUpBehavior';
import { DEFAULT_FOLLOW_UP_BEHAVIOR, isFollowUpBehavior, migrateMessageQueueState, normalizeFollowUpBehavior } from './messageQueueStore';

describe('message queue follow-up compatibility exports', () => {
  it('retains the public API as the same shared helper', () => {
    expect(DEFAULT_FOLLOW_UP_BEHAVIOR).toBe(behavior.DEFAULT_FOLLOW_UP_BEHAVIOR);
    expect(isFollowUpBehavior).toBe(behavior.isFollowUpBehavior);
    expect(normalizeFollowUpBehavior).toBe(behavior.normalizeFollowUpBehavior);
  });

  it.each([undefined, null, 'immediate', 'steer', 'queue', 'invalid'])('preserves persisted-store normalization for %s', followUpBehavior => {
    for (const queueModeEnabled of [undefined, false, true]) {
      const migrated = migrateMessageQueueState({ followUpBehavior, queueModeEnabled });
      expect(migrated).toEqual({ queuedMessages: {}, followUpBehavior: behavior.normalizeFollowUpBehavior(followUpBehavior, queueModeEnabled ?? null) });
    }
  });
});
