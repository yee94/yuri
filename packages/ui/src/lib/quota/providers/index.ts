import type { QuotaProviderId } from '@/types';
import type { ProviderResult } from '@/types';

export interface QuotaProviderMeta {
  id: QuotaProviderId;
  name: string;
}

export const QUOTA_PROVIDERS: QuotaProviderMeta[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'google', name: 'Google' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding' },
  { id: 'nano-gpt', name: 'NanoGPT' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'zai-coding-plan', name: 'z.ai' },
  { id: 'zhipuai-coding-plan', name: 'Zhipu AI Coding Plan' },
  { id: 'minimax-cn-coding-plan', name: 'MiniMax Coding Plan (minimaxi.com)' },
  { id: 'minimax-coding-plan', name: 'MiniMax Coding Plan (minimax.io)' },
  { id: 'ollama-cloud', name: 'Ollama Cloud' },
  { id: 'wafer', name: 'Wafer.ai' },
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'xai', name: 'Grok' },
];

/**
 * Every provider the usage views can show. `order` is the user's arrangement: providers it lists come
 * first in that order, the rest follow in their built-in order.
 */
export const quotaProviders = (results: ProviderResult[], order: readonly string[] = []): QuotaProviderMeta[] => {
  const all = [
    ...QUOTA_PROVIDERS,
    ...results.filter((result) => result.source === 'magpie').map((result) => ({ id: result.providerId, name: result.providerName })),
  ];
  if (order.length === 0) return all;
  const rank = new Map(order.map((id, index) => [id, index]));
  return all
    .map((meta, index) => ({ meta, index, rank: rank.get(meta.id) ?? order.length }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ meta }) => meta);
};
