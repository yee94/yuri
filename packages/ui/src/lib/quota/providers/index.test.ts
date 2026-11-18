import { describe, expect, it } from 'vitest';
import type { ProviderResult } from '@/types';
import { quotaProviders } from './index';

const magpie = { providerId: 'magpie:a:codex', providerName: 'Codex · Magpie', source: 'magpie' } as unknown as ProviderResult;

describe('quotaProviders order', () => {
  it('keeps the built-in order without an arrangement', () => {
    const ids = quotaProviders([magpie]).map((p) => p.id);
    expect(ids[0]).toBe('claude');
    expect(ids.at(-1)).toBe('magpie:a:codex');
  });

  it('puts arranged providers first in the arranged order and leaves the rest where they were', () => {
    const ids = quotaProviders([magpie], ['magpie:a:codex', 'cursor']).map((p) => p.id);
    expect(ids.slice(0, 2)).toEqual(['magpie:a:codex', 'cursor']);
    expect(ids[2]).toBe('claude');
  });
});
