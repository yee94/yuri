export type UsageSelectedModels = Record<string, string[]>;
export function sanitizeUsageSelectedModels(value: unknown): UsageSelectedModels | undefined;
export function defaultUsageSelectedModels(selected: UsageSelectedModels, provider: string, defaults: readonly string[]): { usageSelectedModels: UsageSelectedModels } | null;
export function toggleUsageSelectedModel(selected: UsageSelectedModels, provider: string, model: string, enabled: boolean): { usageSelectedModels: UsageSelectedModels };
