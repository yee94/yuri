import type { ProviderResult, UsageWindow } from '../ui/src/types/quota';

export const usageWindow = (patch: Partial<UsageWindow> = {}): UsageWindow => ({ usedPercent: null, remainingPercent: null, windowSeconds: null, resetAt: null, resetAfterSeconds: null, resetAfterFormatted: null, resetAtFormatted: null, ...patch });
export const usageResult = (patch: Partial<ProviderResult> = {}): ProviderResult => ({ providerId: 'google', providerName: 'Google', configured: true, ok: true, fetchedAt: 1700000000000, usage: { windows: {} }, ...patch });
export function usageFixtureResult(): ProviderResult {
  return usageResult({ usage: { windows: {}, accounts: [
    { id: 'z-account', name: 'First account', user: 'fixture-user', plan: 'Pro', kind: 'oauth', from: 'Fixture source', balance: '$19.25', readAt: 1700000000000, stale: true, error: 'Synthetic refresh failure', windows: { credits_balance: usageWindow({ valueLabel: '$19.25', disablePace: true }), monthly: usageWindow({ usedPercent: 12.6, remainingPercent: 87.4, valueLabel: '13 / 100', disablePace: true, resetAt: 4102444800000 }), unknown: usageWindow() } },
    { id: 'a-account', name: 'Second account', user: '', plan: '', kind: '', from: '', balance: '', readAt: null, stale: false, windows: { daily: usageWindow({ usedPercent: 42, remainingPercent: 58 }) } },
  ], models: { 'gemini/z-model': { windows: { daily: usageWindow({ usedPercent: 7, remainingPercent: 93 }) } }, 'gemini/a-model': { windows: { daily: usageWindow({ usedPercent: 14, remainingPercent: 86 }) } }, 'antigravity/claude-sonnet': { windows: { '5h': usageWindow({ usedPercent: 18, remainingPercent: 82 }) } }, 'other/real-id': { windows: { premium: usageWindow({ valueLabel: 'Unlimited', disablePace: true }) } } } } });
}
