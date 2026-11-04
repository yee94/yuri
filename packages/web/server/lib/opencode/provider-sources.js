import path from 'node:path';
import { currentClient } from './auth.js';
import { getGlobalConfigDirectory } from './config-files.js';

export async function readProviderSources(directory, client = currentClient()) {
  const location = directory ? { directory } : undefined;
  const options = { signal: AbortSignal.timeout(8000) };
  const [providers, entries, integrations] = await Promise.all([
    client.provider.list({ location }, options), client.config.get({ location }, options), client.integration.list({ location }, options),
  ]);
  if (!Array.isArray(providers.data) || !Array.isArray(entries) || !Array.isArray(integrations.data)) throw new Error('Unable to read provider sources');
  const connectionsByIntegration = new Map(integrations.data.map((integration) => {
    if (!integration || typeof integration.id !== 'string' || !Array.isArray(integration.connections)) throw new Error('Unable to read provider sources');
    return [integration.id, integration.connections];
  }));
  const customPath = process.env.OPENCODE_CONFIG ? path.resolve(process.env.OPENCODE_CONFIG) : undefined;
  const globalDirectory = getGlobalConfigDirectory();
  const documentsByProvider = new Map();
  for (const entry of entries) {
    if (entry?.type !== 'document') continue;
    if (!entry.info || typeof entry.info !== 'object') throw new Error('Unable to read provider sources');
    for (const id of Object.keys(entry.info.providers ?? {})) {
      const documents = documentsByProvider.get(id) ?? [];
      documents.push(entry);
      documentsByProvider.set(id, documents);
    }
  }
  const result = Object.create(null);
  for (const provider of providers.data) {
    if (!provider || typeof provider.id !== 'string') throw new Error('Unable to read provider sources');
    const connections = connectionsByIntegration.get(provider.integrationID || provider.id) ?? [];
    const credential = connections.find((connection) => connection.type === 'credential');
    const documents = documentsByProvider.get(provider.id) ?? [];
    const files = documents.flatMap((entry) => {
      if (!entry.path) return [];
      const parent = path.dirname(entry.path);
      const base = path.basename(parent) === '.opencode' ? path.dirname(parent) : parent;
      const scope = entry.path === customPath ? 'custom' : parent === globalDirectory ? 'user'
        : directory && (directory === base || directory.startsWith(`${base}${path.sep}`)) ? 'project' : 'user';
      return [{ path: entry.path, scope }];
    });
    result[provider.id] = {
      auth: { exists: Boolean(credential), ...(credential && ['key', 'oauth', 'external'].includes(credential.method) ? { type: credential.method === 'key' ? 'api' : credential.method } : {}) },
      user: { exists: files.some((file) => file.scope === 'user') },
      project: { exists: files.some((file) => file.scope === 'project') },
      custom: { exists: files.some((file) => file.scope === 'custom') },
      files,
      origin: files.length ? 'config' : documents.length ? 'builtin' : 'runtime',
    };
  }
  return result;
}
