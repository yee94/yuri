import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { UsageWindow } from '@/types/quota';

vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId, className }: { providerId: string; className?: string }) => (
    <span data-logo={providerId} className={className} />
  ),
}));
vi.mock('@/lib/i18n', () => ({
  getCurrentIntlLocale: () => 'en-US',
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => (values?.when ? `resets[${values.when}]` : key) }),
}));
import { SortableUsageItem, SortableUsageList, UsageProviderLogo } from './SortableUsageCards';
import { UsageRingGrid, type UsageRingItem } from './UsageRingGrid';

const win = (patch: Partial<UsageWindow> = {}): UsageWindow => ({
  usedPercent: 30, remainingPercent: 70, windowSeconds: null, resetAfterSeconds: null,
  resetAt: null, resetAtFormatted: null, resetAfterFormatted: null, ...patch,
});
const item = (key: string, window: UsageWindow, label = key): UsageRingItem => ({ key, label, window });
const render = (items: UsageRingItem[], displayMode: 'usage' | 'remaining' = 'usage') =>
  renderToStaticMarkup(<UsageRingGrid items={items} displayMode={displayMode} timeFormatPreference="24h" />);

describe('UsageRingGrid', () => {
  it('draws one neutral ring per window with a percentage', () => {
    const html = render([item('5h', win({ usedPercent: 30 })), item('7d', win({ usedPercent: 85, remainingPercent: 15 }))]);
    expect(html.match(/role="progressbar"/g)).toHaveLength(2);
    expect(html).toContain('30%');
    expect(html).toContain('85%');
    expect(html).not.toContain('var(--status-');
  });

  it('turns a nearly spent window amber', () => {
    const html = render([item('7d', win({ usedPercent: 95, remainingPercent: 5 }))]);
    expect(html).toContain('var(--status-warning)');
  });

  it('follows the used/remaining display mode but keeps the amber on used', () => {
    const html = render([item('7d', win({ usedPercent: 95, remainingPercent: 5 }))], 'remaining');
    expect(html).toContain('aria-valuenow="5"');
    expect(html).toContain('var(--status-warning)');
  });

  it('says one reset time when the windows agree and names the later ones when they differ', () => {
    const now = Date.now();
    const hour = 3600_000;
    const same = render([
      item('a', win({ resetAt: now + 5 * hour }), 'A'),
      item('b', win({ resetAt: now + 5 * hour }), 'B'),
    ]);
    expect(same.match(/>resets\[/g)).toHaveLength(1);
    const apart = render([
      item('a', win({ resetAt: now + 5 * hour }), 'A'),
      item('b', win({ resetAt: now + 30 * hour }), 'B'),
    ]);
    expect(apart.match(/>resets\[/g)).toHaveLength(1);
    expect(apart).toMatch(/\] · B /);
  });

  it('names rings by their span and pool like Magpie', () => {
    const html = render([
      item('a', win({ label: '5 hours' }), 'x'),
      item('b', win({ label: '7 days', pool: 'Claude & GPT' }), 'y'),
    ]);
    expect(html).toContain('>5h<');
    expect(html).toContain('>Claude 7d<');
  });

  it('draws a card\'s first three windows as rings and says the rest in words below', () => {
    const html = render(['a', 'b', 'c', 'd', 'e'].map((key) => item(key, win())));
    expect(html.match(/role="progressbar"/g)).toHaveLength(3);
    expect(html).not.toContain('+2');
    expect(html).toContain('>d<');
    expect(html).toContain('>e<');
  });

  it('puts a total window ahead of the per-model ones before the cap', () => {
    const html = render([
      item('a', win({ usedPercent: 11 }), 'Cursor Models'),
      item('b', win({ usedPercent: 22 }), 'Other Models'),
      item('c', win({ usedPercent: 33 }), 'Grok Bot'),
      item('d', win({ usedPercent: 44 }), 'Total'),
    ]);
    expect(html.indexOf('Total · 44%')).toBeLessThan(html.indexOf('Cursor Models · 11%'));
    expect(html.match(/role="progressbar"/g)).toHaveLength(3);
    expect(html).toContain('>Grok Bot<');
    expect(html).toContain('>33%<');
  });

  it('keeps pooled windows to three rings too and says the rest in words', () => {
    const html = render(['a', 'b', 'c', 'd'].map((key) => item(key, win({ pool: 'Gemini' }))));
    expect(html.match(/role="progressbar"/g)).toHaveLength(3);
    expect(html).toContain('>d<');
  });

  it('names a remote Magpie\'s pooled window by its span, not by its whole name', () => {
    const html = render([item('a', win({ label: 'Gemini · 5 hours', pool: 'Gemini' }), 'Gemini · 5 hours')]);
    expect(html).toContain('>Gemini 5h<');
  });

  it('keeps windows without a percentage as a label/value line instead of an empty ring', () => {
    const html = render([item('credits', win({ usedPercent: null, remainingPercent: null, valueLabel: '$12' }), 'Credits')]);
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('Credits');
    expect(html).toContain('$12');
  });

  it('titles each account only when several accounts share the provider', () => {
    const html = render([
      item('a1', win({ accountName: 'alice' })),
      item('a2', win({ accountName: 'alice' })),
      item('b1', win({ accountName: 'bob' })),
    ]);
    expect(html.match(/>alice</g)).toHaveLength(1);
    expect(html.match(/>bob</g)).toHaveLength(1);
    expect(html.match(/role="progressbar"/g)).toHaveLength(3);
  });

  it('shows the pace prediction only when asked', () => {
    const now = Date.now();
    const window = win({ usedPercent: 60, resetAt: now + 3600_000, windowSeconds: 7200 });
    const off = renderToStaticMarkup(<UsageRingGrid items={[item('x', window)]} displayMode="usage" timeFormatPreference="24h" />);
    const on = renderToStaticMarkup(<UsageRingGrid items={[item('x', window)]} displayMode="usage" timeFormatPreference="24h" showPace />);
    expect(off).not.toContain('+120%');
    expect(on).toContain('+120%');
  });

  it('opts usage card logo drag handles out of the 36px mobile button floor', () => {
    const html = renderToStaticMarkup(
      <SortableUsageList ids={['claude', 'antigravity']}>
        <SortableUsageItem id="claude">
          <UsageProviderLogo providerId="claude" name="Claude Code" className="size-4 shrink-0" />
        </SortableUsageItem>
        <SortableUsageItem id="antigravity">
          <UsageProviderLogo providerId="antigravity" name="Antigravity" className="size-4 shrink-0" />
        </SortableUsageItem>
      </SortableUsageList>,
    );
    expect(html.match(/data-usage-drag-handle="true"/g)).toHaveLength(2);
    expect(html.match(/data-mobile-press-feedback="none"/g)).toHaveLength(2);

    const here = dirname(fileURLToPath(import.meta.url));
    const mobileCss = readFileSync(join(here, '../../../styles/mobile.css'), 'utf-8');
    expect(mobileCss).toMatch(
      /button\[data-usage-drag-handle="true"\],\s*:root\.mobile-pointer:not\(\.desktop-runtime\)\s*\[data-usage-drag-handle="true"\]\[role="button"\]\s*\{\s*min-height:\s*0\s*!important;\s*min-width:\s*0\s*!important;/,
    );
  });
});
