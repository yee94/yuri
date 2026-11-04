export function getProviderSources(providerId: string, directory?: string): {
  sources: Record<'auth' | 'user' | 'project' | 'custom', { exists: boolean; path?: string | null }>;
};
export function removeProviderConfig(providerId: string, directory?: string, scope?: 'user' | 'project' | 'custom'): boolean;
export function removeProviderConfiguration(providerId: string, directory?: string): boolean;
