import { ConfigProvider } from '@opencode/schema/config/provider';
import { Schema } from 'effect';
import { currentClient } from './auth.js';
import { getConfigForPath, isPlainObject, readConfigLayers, writeConfig } from './config-files.js';
import { customProviderProtocols } from '../../../shared/custom-provider-protocol.js';

const packages = new Set(customProviderProtocols.map((protocol) => protocol.package));
const pending = new Set();
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });

function validate(input) {
  if (!isPlainObject(input) || (input.providerId !== undefined && (typeof input.providerId !== 'string'
    || !/^custom-[a-z0-9-]{1,80}$/.test(input.providerId)))) throw failure('INVALID_PROVIDER');
  let config;
  try {
    config = Schema.decodeUnknownSync(ConfigProvider.Info, { onExcessProperty: 'error' })(input.config);
  } catch {
    throw failure('INVALID_PROVIDER');
  }
  if (!config.name?.trim() || !packages.has(config.package)
    || !isPlainObject(config.settings) || Object.keys(config.settings).some((key) => key !== 'baseURL')
    || !isPlainObject(config.models) || !Object.keys(config.models).length
    || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw failure('INVALID_PROVIDER');
  try {
    const url = new URL(config.settings.baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw failure('INVALID_BASE_URL');
  }
  for (const [id, model] of Object.entries(config.models)) {
    if (!id.trim() || /[\s#]/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)
      || Object.keys(model).some((key) => !['name', 'capabilities', 'limit'].includes(key))
      || Object.values(model.limit ?? {}).some((value) => !Number.isSafeInteger(value) || value <= 0)
      || (model.limit?.context && model.limit?.output && model.limit.output > model.limit.context)) throw failure('INVALID_MODELS');
  }
  if (Object.keys(input.config).some((key) => !['name', 'package', 'settings', 'models'].includes(key))) throw failure('INVALID_PROVIDER');
  return { providerId: input.providerId, config: input.config, apiKey: input.apiKey?.trim() };
}

function targetForCreation(providerId, directory) {
  const layers = readConfigLayers(directory);
  if (layers.documents.some(({ config }) => Object.hasOwn(config.providers ?? {}, providerId)
    || Object.hasOwn(config.provider ?? {}, providerId))) throw failure('PROVIDER_EXISTS', 409);
  const path = layers.paths.customPath || layers.paths.userPath;
  const config = getConfigForPath(layers, path);
  if (config.providers !== undefined && !isPlainObject(config.providers)) throw failure('INVALID_PROVIDER_CONFIG');
  return { path, config };
}

async function allocateProviderId(name, directory, client) {
  const location = directory ? { directory } : undefined;
  const [providers, integrations] = await Promise.all([
    client.provider.list({ location }, { signal: AbortSignal.timeout(8000) }),
    client.integration.list({ location }, { signal: AbortSignal.timeout(8000) }),
  ]);
  if (!Array.isArray(providers.data) || !Array.isArray(integrations.data)) throw failure('PROVIDER_SAVE_FAILED', 502);
  const layers = readConfigLayers(directory);
  const used = new Set(['__proto__', 'constructor', 'prototype', ...pending,
    ...providers.data.map((entry) => entry.id), ...integrations.data.map((entry) => entry.id),
    ...layers.documents.flatMap(({ config }) => [...Object.keys(config.providers ?? {}), ...Object.keys(config.provider ?? {})]),
  ]);
  const base = name.normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 80).replace(/^-+|-+$/g, '') || 'custom-provider';
  let id = base;
  for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
  pending.add(id);
  return id;
}

/** Keys only enter OpenCode's credential store; JSONC edits share the atomic config writer. */
export async function createCustomProvider(input, directory, client = currentClient()) {
  const validated = validate(input);
  const { config, apiKey } = validated;
  const providerId = validated.providerId ?? await allocateProviderId(config.name, directory, client);
  if (validated.providerId) {
    if (pending.has(providerId)) throw failure('PROVIDER_EXISTS', 409);
    pending.add(providerId);
  }
  let credentialID;
  try {
    targetForCreation(providerId, directory);
    if (apiKey) {
      try {
        const credential = await client.credential.create({ integrationID: providerId, label: config.name,
          value: { type: 'key', key: apiKey }, activate: true }, { signal: AbortSignal.timeout(15000) });
        credentialID = credential.id;
      } catch {
        throw failure('PROVIDER_CREDENTIAL_FAILED', 502);
      }
    }
    const target = targetForCreation(providerId, directory);
    writeConfig({ ...target.config, $schema: target.config.$schema ?? 'https://opencode.ai/config.json',
      providers: { ...target.config.providers, [providerId]: config } }, target.path);
    return { providerId };
  } catch (error) {
    if (credentialID) {
      try {
        await client.credential.remove({ credentialID }, { signal: AbortSignal.timeout(15000) });
      } catch {
        throw failure('PROVIDER_CLEANUP_FAILED', 500);
      }
    }
    if (typeof error.status === 'number') throw error;
    throw failure('PROVIDER_SAVE_FAILED', 500);
  } finally {
    pending.delete(providerId);
  }
}
