import type { OpenCodeClient } from '@opencode/client';
export type ProviderSources = {
  auth: { exists: boolean; type?: 'api' | 'oauth' | 'external' };
  user: { exists: boolean };
  project: { exists: boolean };
  custom: { exists: boolean };
  files: Array<{ path: string; scope: 'user' | 'project' | 'custom' }>;
  origin: 'config' | 'builtin' | 'runtime';
};
export function readProviderSources(directory?: string, client?: Pick<OpenCodeClient, 'provider' | 'config' | 'integration'>): Promise<Record<string, ProviderSources>>;
