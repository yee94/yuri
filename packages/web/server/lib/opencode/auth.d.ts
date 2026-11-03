import type { OpenCodeClient } from '@opencode/client';

type CredentialClient = Pick<OpenCodeClient, 'credential'> & {
  config: Pick<OpenCodeClient['config'], 'get'>;
};

export type ProviderCredential =
  | { type: 'api'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string; enterpriseUrl?: string };
export function configureOpenCodeCredentials(resolveClient: (() => CredentialClient) | null): void;
export function currentClient(): CredentialClient;
export function openCodeCredentialSource(deps: {
  buildOpenCodeUrl: (path: string, prefix?: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
}): () => OpenCodeClient;
export function readOpenCodeCredentials(): Promise<Record<string, ProviderCredential>>;
export function readOpenCodeProviderConfigs(directory?: string): Promise<Record<string, { name?: string; settings?: Record<string, unknown>; headers?: Record<string, string> }>>;
export function getProviderAuth(providerId: string): Promise<ProviderCredential | null>;
export function removeProviderAuth(providerId: string): Promise<boolean>;
