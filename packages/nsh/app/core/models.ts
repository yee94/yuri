import { signal } from 'nsh';
import { list, record, request, textOf, unwrap } from './host';
import { projects } from './store';

export type Model = { id: string; name: string };
export type Provider = { id: string; name: string; models: Model[] };
export type Agent = { name: string; description: string; mode: string };

const state = {
  providers: signal<Provider[]>([]),
  defaultModel: signal<{ providerID: string; modelID: string } | null>(null),
  agents: signal<Agent[]>([]),
  loading: signal(false),
  error: signal(''),
};

export const providers = () => state.providers();
export const defaultModel = () => state.defaultModel();
export const agents = () => state.agents();
export const catalogLoading = () => state.loading();
export const catalogError = () => state.error();

export const catalogDirectory = () => projects()[0]?.path ?? '';

const parseProviders = (payload: unknown): Provider[] =>
  list(record(unwrap(payload)).providers)
    .map((row) => ({
      id: textOf(row.id),
      name: textOf(row.name) || textOf(row.id),
      models: Object.entries(record(row.models)).map(([id, value]) => ({
        id,
        name: textOf(record(value).name) || id,
      })),
    }))
    .filter((provider) => provider.id);

const parseDefault = (payload: unknown): { providerID: string; modelID: string } | null => {
  const value = record(record(unwrap(payload)).default);
  const providerID = textOf(value.provider);
  const modelID = textOf(value.model);
  return providerID && modelID ? { providerID, modelID } : null;
};

export async function loadCatalog(force = false): Promise<void> {
  if (!force && state.providers().length && !state.error()) return;
  state.loading.set(true);
  state.error.set('');
  const directory = catalogDirectory();
  const query = directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : '';
  const [catalog, agentList] = await Promise.allSettled([
    request('/api/config/catalog/providers', 'GET'),
    request(`/api/agent${query}`, 'GET'),
  ]);
  if (catalog.status === 'fulfilled') {
    state.providers.set(parseProviders(catalog.value));
    state.defaultModel.set(parseDefault(catalog.value));
  } else {
    state.error.set(catalog.reason instanceof Error ? catalog.reason.message : String(catalog.reason));
  }
  if (agentList.status === 'fulfilled') {
    const rows = Array.isArray(agentList.value) ? agentList.value : list(record(agentList.value).agents);
    state.agents.set(
      rows
        .map(record)
        .map((row) => ({
          name: textOf(row.name),
          description: textOf(row.description),
          mode: textOf(row.mode) || 'agent',
        }))
        .filter((agent) => agent.name),
    );
  }
  state.loading.set(false);
}

export const modelsOf = (providerID: string) => providers().find((provider) => provider.id === providerID)?.models ?? [];
