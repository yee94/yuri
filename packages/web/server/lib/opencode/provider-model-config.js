import { ConfigProvider } from '@opencode/schema/config/provider';
import { Schema } from 'effect';
import { getJsonEntrySource, getJsonWriteTarget, isPlainObject, readConfigLayers, writeConfig } from './config-files.js';

const invalid = () => Object.assign(new Error('INVALID_MODEL'), { status: 400 });
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[\s#]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

/** Only model presentation/capabilities are editable; credentials and routing remain host-owned. */
export function updateProviderModel(input, directory) {
  if (!isPlainObject(input) || !validId(input.providerId) || !validId(input.modelId)
    || typeof input.name !== 'string' || input.name.length > 1024
    || typeof input.tools !== 'boolean' || typeof input.vision !== 'boolean'
    || !Array.isArray(input.inputModalities) || input.inputModalities.some((value) => !['text', 'image', 'audio', 'video', 'pdf'].includes(value))
    || [input.context, input.output].some((value) => value !== null && (!Number.isSafeInteger(value) || value <= 0))
    || (input.context && input.output && input.output > input.context)) throw invalid();
  const layers = readConfigLayers(directory);
  const source = getJsonEntrySource(layers, 'providers', input.providerId);
  const target = source.exists ? source : getJsonWriteTarget(layers);
  const provider = target.config.providers?.[input.providerId] ?? {};
  const existing = provider.models?.[input.modelId] ?? {};
  if (!isPlainObject(provider) || !isPlainObject(existing)
    || (provider.models !== undefined && !isPlainObject(provider.models))) throw invalid();
  const limit = { ...existing.limit };
  for (const key of ['context', 'output']) {
    if (input[key] === null) delete limit[key];
    else limit[key] = input[key];
  }
  const inheritedInput = layers.mergedConfig.providers?.[input.providerId]?.models?.[input.modelId]?.capabilities?.input;
  const modalities = (Array.isArray(inheritedInput) ? inheritedInput : input.inputModalities).filter((value) => value !== 'image');
  const model = { ...existing, name: input.name.trim() || input.modelId, limit,
    capabilities: { ...existing.capabilities, tools: input.tools,
      input: input.vision ? [...modalities, 'image'] : modalities } };
  try { Schema.decodeUnknownSync(ConfigProvider.Info)({ models: { [input.modelId]: model } }); }
  catch { throw invalid(); }
  writeConfig({ ...target.config, providers: { ...target.config.providers,
    [input.providerId]: { ...provider, models: { ...provider.models, [input.modelId]: model } } } }, target.path);
  return { providerId: input.providerId, modelId: input.modelId };
}
