import type { OpenCodeClient } from '@opencode/client';

type LocationReleaseClient = {
  debug: { location: Pick<OpenCodeClient['debug']['location'], 'evict'> };
};

export type LocationReleaseResult = { state: 'released' | 'timeout' | 'failed' | 'unavailable' };
export function releaseDeletedWorktreeLocation(input: {
  getClient: () => LocationReleaseClient | null;
  directory: string;
  timeoutMs?: number;
}): Promise<LocationReleaseResult>;
