/**
 * Built-in OpenCode provider IDs that Yuri must never surface or select.
 * Note: `opencode-go` is a separate provider and remains allowed.
 */
export const BLOCKED_PROVIDER_IDS = Object.freeze(new Set(['opencode']));

export const isBlockedProviderId = (providerId) => (
  typeof providerId === 'string' && BLOCKED_PROVIDER_IDS.has(providerId.trim())
);
