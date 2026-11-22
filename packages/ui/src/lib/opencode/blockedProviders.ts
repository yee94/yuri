/**
 * Built-in OpenCode provider IDs that Yuri must never surface or select.
 * Note: `opencode-go` is a separate provider and remains allowed.
 */
export const BLOCKED_PROVIDER_IDS = new Set<string>(['opencode']);

export const isBlockedProviderId = (providerId: string | null | undefined): boolean => (
  typeof providerId === 'string' && BLOCKED_PROVIDER_IDS.has(providerId.trim())
);
