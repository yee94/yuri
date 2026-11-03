import type { Session } from '@/lib/opencode/v2-types';

export type SessionMetadataRecord = Record<string, unknown>;

export const getSessionMetadata = (session: Session | null | undefined): SessionMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as SessionMetadataRecord : {};
};
