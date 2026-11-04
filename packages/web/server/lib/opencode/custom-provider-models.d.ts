export type DiscoveredProviderModel = { id: string; name: string; context?: number; output?: number };
export function discoverCustomProviderModels(input: unknown, options?: { signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<{ models: DiscoveredProviderModel[] }>;
