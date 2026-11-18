import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderResult, UsageWindow } from '@/types';

const state = vi.hoisted(() => ({ results: [] as ProviderResult[], selectedProviderId: 'magpie:gateway:claude', isLoading: false,
  selectedModels: {}, dropdownProviderIds: ['magpie:gateway:claude'], expandedFamilies: {}, displayMode: 'usage', showPredValues: true,
  setSelectedProvider: vi.fn(), setDropdownProviderIds: vi.fn(), loadSettings: async () => {}, fetchAllQuotas: async () => {}, applyDefaultSelections: () => {},
}));
vi.mock('@/stores/useQuotaStore', () => ({ useQuotaStore: (select: (s: typeof state) => unknown) => select(state), useQuotaAutoRefresh: () => {} }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (s: { timeFormatPreference: string }) => unknown) => select({ timeFormatPreference: '24h' }) }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: async () => {} }));
vi.mock('@/lib/i18n', () => ({ getCurrentIntlLocale: () => 'en-US', useI18n: () => ({ locale: 'en', t: (key: string, values?: Record<string, unknown>) => values?.provider ?? key }) }));
vi.mock('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { UsagePage } from './UsagePage';
import { UsageCard } from './UsageCard';

describe('Magpie account quota rendering', () => {
  it.each([
    [18277, '12 days 16 hours 37 minutes'],
    [1440, '1 day'],
    [61, '1 hour 1 minute'],
    [0, '0 minutes'],
  ])('formats %i minutes as a readable duration', (minutes, expected) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
    try {
      const window: UsageWindow = { usedPercent: 20, remainingPercent: 80,
        resetAt: Date.now() + minutes * 60000, resetAfterSeconds: null, resetAtFormatted: null,
        resetAfterFormatted: null, windowSeconds: null, disablePace: true };
      expect(renderToStaticMarkup(<UsageCard title="daily" window={window} />)).toContain(`(${expected})`);
    } finally {
      clock.mockRestore();
    }
  });
  it('renders distinct accounts, every window, reset time, balance and cached errors without model-family heuristics', () => {
    const window: UsageWindow = { usedPercent: 20, remainingPercent: 80, resetAt: Date.parse('2026-10-19T12:34:00Z'),
      resetAfterSeconds: null, resetAtFormatted: null, resetAfterFormatted: null, windowSeconds: null, disablePace: true, valueLabel: '20 / 100', label: 'daily' };
    state.results = [{ providerId: 'magpie:gateway:claude', providerName: 'Claude · Magpie', source: 'magpie', sourceId: 'gateway',
      ok: false, configured: true, fetchedAt: 1, usage: { windows: { flattened: window }, accounts: [
        { id: 'a', name: 'Account A', user: '', plan: 'Pro', kind: 'subscription', from: '', balance: '', readAt: 1, stale: false, windows: { daily: window, weekly: { ...window, label: 'weekly', usedPercent: 70, valueLabel: null } } },
        { id: 'b', name: 'Account B', user: '', plan: '', kind: 'balance', from: '', balance: '$12', readAt: 1, stale: true, error: 'unavailable', windows: { balance: { ...window, label: 'credits_balance', usedPercent: null, remainingPercent: null, resetAt: null, valueLabel: '$12' } } },
      ] } }];
    const html = renderToStaticMarkup(<UsagePage />);
    expect(html).toContain('Claude · Magpie');
    expect(html).toContain('Account A'); expect(html).toContain('Account B');
    expect(html).toContain('20% · 20 / 100'); expect(html).toContain('70%'); expect(html).toContain('$12');
    expect(html).toContain('settings.usage.magpie.cached');
    expect(html).toContain('settings.usage.page.state.refreshFailedTitle');
    expect(html).not.toContain('flattened');
    expect(html.match(/role="progressbar"/g)).toHaveLength(2);
    expect(html).not.toContain('Expected usage');
    expect(html).toContain(':34');
    expect(html).toContain('minutes');
  });
  it('retains the selected Magpie provider and its reading during a partial in-flight refresh', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const window: UsageWindow = { usedPercent: 20, remainingPercent: 80, resetAt: null,
      resetAfterSeconds: null, resetAtFormatted: null, resetAfterFormatted: null, windowSeconds: null, disablePace: true, valueLabel: '20 / 100', label: 'daily' };
    const cursor: ProviderResult = { providerId: 'magpie:gateway:cursor', providerName: 'Cursor · Magpie', source: 'magpie', sourceId: 'gateway', ok: true, configured: true, fetchedAt: 1, usage: { windows: { daily: window } } };
    const codex: ProviderResult = { providerId: 'magpie:remote:codex', providerName: 'Codex · Remote Magpie · Magpie', source: 'magpie', sourceId: 'remote', ok: true, configured: true, fetchedAt: 1, usage: { windows: { daily: window } } };
    state.selectedProviderId = codex.providerId;
    state.results = [cursor, codex];
    state.isLoading = false;
    state.setSelectedProvider.mockClear();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<UsagePage />); });
      expect(host.textContent).toContain('Codex · Remote Magpie · Magpie');
      state.results = [cursor];
      state.isLoading = true;
      await act(async () => { root.render(<UsagePage />); });
      expect(state.setSelectedProvider).not.toHaveBeenCalled();
      expect(host.textContent).toContain('Codex · Remote Magpie · Magpie');
      state.isLoading = false;
      await act(async () => { root.render(<UsagePage />); });
      expect(state.setSelectedProvider).toHaveBeenCalledWith(cursor.providerId);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
    }
  });
});
