import { describe, expect, test } from 'vitest';
import { getProviderLogoCandidates } from './providerBrand';

const available = new Set(['openai', 'opencode', 'anthropic', 'magpie', 'wafer.ai']);
const resolve = (id: string) => getProviderLogoCandidates(id, available).find(candidate => available.has(candidate));
describe('shared Web/native Provider artwork candidates', () => {
    test('normalizes aliases and prefixes without confusing models with provider brands', () => {
        expect(resolve('provider.codex')).toBe('openai'); expect(resolve('opencode-go')).toBe('opencode');
        expect(resolve('Models.Claude')).toBe('anthropic'); expect(resolve('wafer')).toBe('wafer.ai');
        expect(resolve('unknown')).toBeUndefined();
    });
    test('decodes actual Magpie brand before the Magpie fallback and handles malformed IDs', () => {
        expect(resolve('magpie:account:openai%2Fcustom')).toBe('openai');
        expect(resolve('magpie:account:unknown')).toBe('magpie');
        expect(resolve('magpie:account:%invalid')).toBe('magpie');
    });
});
