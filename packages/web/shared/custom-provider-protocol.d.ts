export const customProviderProtocols: ReadonlyArray<{ label: string; package: string; version: string; path: string }>;
export function resolveCustomProviderURL(value: string, pkg: string, modelID?: string): {
  baseURL: string; requestURL: string; modelsURL: string; inferredVersion: boolean;
} | null;
