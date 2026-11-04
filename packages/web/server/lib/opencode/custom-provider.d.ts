import type { OpenCodeClient } from '@opencode/client';
export function createCustomProvider(input: unknown, directory?: string, client?: Pick<OpenCodeClient, 'credential' | 'provider' | 'integration'>): Promise<{ providerId: string }>;
