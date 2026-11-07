export type FollowUpBehavior = 'steer' | 'queue';

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';
export const isFollowUpBehavior = (value: unknown): value is FollowUpBehavior => value === 'steer' || value === 'queue';
export const normalizeFollowUpBehavior = (value: unknown, legacyQueueModeEnabled?: boolean | null): FollowUpBehavior => {
  if (value === 'immediate') return 'steer';
  if (isFollowUpBehavior(value)) return value;
  return legacyQueueModeEnabled === false ? 'steer' : 'queue';
};
