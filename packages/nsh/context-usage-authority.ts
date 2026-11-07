import { record, text, unwrap } from './model';
import type { ContextUsageProvider, ContextUsageScope, ContextUsageSnapshot } from './context-usage-core';

/** Catalog parsing only; selection is always an exact provider/model identity lookup. */
export function contextUsageProvidersFrom(payload: unknown): ContextUsageProvider[] {
  const root = record(payload);
  if (root.schemaVersion !== 1 || root.ok === false || !Array.isArray(root.providers)) throw new Error('Invalid context overview catalog');
  return root.providers.map(raw => {
    const provider = record(raw), models = record(provider.models);
    if (!text(provider.id) || !provider.models || typeof provider.models !== 'object' || Array.isArray(provider.models)) throw new Error('Invalid context overview provider');
    return { id: text(provider.id), name: text(provider.name) || undefined, models: Object.entries(models).map(([key, rawModel]) => {
      const model = record(rawModel), limit = record(model.limit);
      return { id: text(model.id) || key, name: text(model.name) || undefined, ...(typeof limit.context === 'number' && Number.isFinite(limit.context) ? { limit: { context: limit.context } } : {}) };
    }) };
  });
}

export function contextUsageSessionFrom(payload: unknown, scope: ContextUsageScope): ContextUsageSnapshot['session'] {
  const session = record(unwrap(payload)), directory = text(record(session.location).directory) || text(session.directory), time = record(session.time);
  if (session.id !== scope.sessionID || directory && directory !== scope.directory) throw new Error('Context overview session scope mismatch');
  return { id: scope.sessionID, title: text(session.title) || undefined, time: { ...(typeof time.created === 'number' && Number.isFinite(time.created) ? { created: time.created } : {}) } };
}

/** Optional cold page read. Already held authoritative session/catalog snapshots bypass GETs. */
export async function readContextUsageMetadata(options: {
  scope: ContextUsageScope;
  read: (path: string) => Promise<unknown>;
  session?: ContextUsageSnapshot['session'];
  providers?: ContextUsageProvider[];
}) {
  const scope = { ...options.scope }, directory = encodeURIComponent(scope.directory);
  const [session, providers] = await Promise.all([
    options.session ? Promise.resolve(contextUsageSessionFrom(options.session, scope)) : options.read(`/api/session/${encodeURIComponent(scope.sessionID)}?directory=${directory}`).then(payload => contextUsageSessionFrom(payload, scope)),
    options.providers ? Promise.resolve(options.providers) : options.read(`/api/config/catalog/providers?directory=${directory}`).then(contextUsageProvidersFrom),
  ]);
  return { session, providers };
}
