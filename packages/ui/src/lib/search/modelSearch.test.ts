import { describe, expect, test } from 'bun:test';

import { buildModelSearchText, matchesModelSearch, normalizeModelSearchValue, scoreModelSearch } from './modelSearch';

describe('normalizeModelSearchValue', () => {
  test('builds lower, compact, and token forms', () => {
    expect(normalizeModelSearchValue('GLM-5.2')).toEqual({
      lower: 'glm-5.2',
      compact: 'glm52',
      tokens: ['glm', '5', '2'],
    });
  });
});

describe('matchesModelSearch', () => {
  test('matches when separators differ between query and model name', () => {
    expect(matchesModelSearch('GLM-5.2', 'GLM 5.2')).toBe(true);
    expect(matchesModelSearch('GLM-5.2', 'glm5.2')).toBe(true);
    expect(matchesModelSearch('GLM-5.2', 'glm-52')).toBe(true);
    expect(matchesModelSearch('DeepSeek V4 Pro', 'deepseek-v4')).toBe(true);
    expect(matchesModelSearch('Claude Sonnet 4.5', 'claude-sonnet-4.5')).toBe(true);
  });

  test('matches project names when separators differ', () => {
    expect(matchesModelSearch('oh-my-opencode-slim', 'oh my opencode')).toBe(true);
    expect(matchesModelSearch('yuri-local', 'yurilocal')).toBe(true);
  });

  test('still matches plain substrings and empty query', () => {
    expect(matchesModelSearch('GPT-5.5', 'gpt-5')).toBe(true);
    expect(matchesModelSearch('Gemini 3.5 Flash', '')).toBe(true);
    expect(matchesModelSearch('Gemini 3.5 Flash', '   ')).toBe(true);
  });

  test('does not match unrelated models', () => {
    expect(matchesModelSearch('GLM-5.2', 'gpt 5.5')).toBe(false);
    expect(matchesModelSearch('Kimi K2.7 Code', 'deepseek')).toBe(false);
  });
});

describe('scoreModelSearch', () => {
  test('returns 0 for non-matches and tiers matches by text quality', () => {
    expect(scoreModelSearch('GLM-5.2', 'Zhipu', 'gpt')).toBe(0);
    const exact = scoreModelSearch('Claude', 'A', 'claude');
    const prefix = scoreModelSearch('Claude Sonnet', 'A', 'claude');
    const token = scoreModelSearch('Fast Claude', 'A', 'claude');
    const substring = scoreModelSearch('MegaClaudeX', 'A', 'claude');
    const providerOnly = scoreModelSearch('Auto', 'Claude Cloud', 'claude');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(token);
    expect(token).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(providerOnly);
    expect(providerOnly).toBeGreaterThan(0);
  });

  test('recency boost decays by rank and favorites add a small boost', () => {
    const base = scoreModelSearch('Claude Sonnet', 'A', 'claude');
    const first = scoreModelSearch('Claude Sonnet', 'A', 'claude', { recencyRank: 0 });
    const third = scoreModelSearch('Claude Sonnet', 'A', 'claude', { recencyRank: 2 });
    expect(first).toBeGreaterThan(third);
    expect(third).toBeGreaterThan(base);
    expect(scoreModelSearch('Claude Sonnet', 'A', 'claude', { recencyRank: 9 })).toBe(base);
    expect(scoreModelSearch('Claude Sonnet', 'A', 'claude', { favorite: true })).toBeGreaterThan(base);
  });

  test('a recently used substring hit outranks an unused prefix hit but not an exact name', () => {
    const recentSubstring = scoreModelSearch('Sonnet Claude Lite', 'Cursor', 'claude', { recencyRank: 0 });
    const unusedPrefix = scoreModelSearch('Claude Opus', 'Anthropic', 'claude');
    const unusedExact = scoreModelSearch('Claude', 'Anthropic', 'claude');
    expect(recentSubstring).toBeGreaterThan(unusedPrefix);
    expect(unusedExact).toBeGreaterThan(unusedPrefix);
  });
});

describe('provider/model ID search', () => {
  const text = buildModelSearchText({
    providerName: 'Claude Code · VPS US',
    providerID: 'magpie-remote-magpie%2Fvps-us%2Fclaude',
    modelName: 'Claude Sonnet 5.5',
    modelID: 'vps-us/claude/claude-sonnet-5-5',
  });

  test('space-separated terms may hit different parts of the candidate', () => {
    expect(matchesModelSearch(text, 'vpsus sonnet')).toBe(true);
    expect(matchesModelSearch(text, 'sonnet vps-us')).toBe(true);
    expect(matchesModelSearch(text, 'vpsus gemini')).toBe(false);
  });

  test('decodes URL-encoded provider IDs so ID fragments match', () => {
    expect(matchesModelSearch(text, 'vps-us/claude/claude-sonnet')).toBe(true);
    expect(matchesModelSearch(text, 'magpie-remote-magpie/vps-us/claude')).toBe(true);
    expect(buildModelSearchText({ providerName: 'P', providerID: '100%', modelName: 'M', modelID: 'm' })).toBe('P 100% M m');
  });

  test('scores an ID-only hit above zero', () => {
    expect(scoreModelSearch('Claude Sonnet 5.5', 'Claude Code', 'vpsus sonnet', { searchText: text })).toBeGreaterThan(0);
    expect(scoreModelSearch('Claude Sonnet 5.5', 'Claude Code', 'vpsus sonnet')).toBe(0);
  });
});

describe('selected provider boost', () => {
  test('is smaller than a one-step recency gap and ranks same-provider hits first', () => {
    const base = scoreModelSearch('Claude Opus', 'A', 'claude');
    const boosted = scoreModelSearch('Claude Opus', 'A', 'claude', { selectedProvider: true });
    expect(boosted).toBeGreaterThan(base);
    expect(boosted - base).toBeLessThan(8);
  });
});
