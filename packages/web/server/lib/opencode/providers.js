import {
  CONFIG_FILE,
  readConfigLayers,
  isPlainObject,
  getConfigForPath,
  writeConfig,
} from './shared.js';

function getProviderSources(providerId, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const { userConfig, projectConfig, customConfig, paths } = layers;

  const customProviders = isPlainObject(customConfig?.provider) ? customConfig.provider : {};
  const customProvidersAlias = isPlainObject(customConfig?.providers) ? customConfig.providers : {};
  const projectProviders = isPlainObject(projectConfig?.provider) ? projectConfig.provider : {};
  const projectProvidersAlias = isPlainObject(projectConfig?.providers) ? projectConfig.providers : {};
  const userProviders = isPlainObject(userConfig?.provider) ? userConfig.provider : {};
  const userProvidersAlias = isPlainObject(userConfig?.providers) ? userConfig.providers : {};

  const customExists =
    Object.prototype.hasOwnProperty.call(customProviders, providerId) ||
    Object.prototype.hasOwnProperty.call(customProvidersAlias, providerId);
  const projectExists =
    Object.prototype.hasOwnProperty.call(projectProviders, providerId) ||
    Object.prototype.hasOwnProperty.call(projectProvidersAlias, providerId);
  const userExists =
    Object.prototype.hasOwnProperty.call(userProviders, providerId) ||
    Object.prototype.hasOwnProperty.call(userProvidersAlias, providerId);

  return {
    sources: {
      auth: { exists: false },
      user: { exists: userExists, path: layers.userLayers.findLast((layer) => layer.config?.provider?.[providerId] !== undefined || layer.config?.providers?.[providerId] !== undefined)?.path || paths.userPath },
      project: { exists: projectExists, path: layers.projectLayers.findLast((layer) => layer.config?.provider?.[providerId] !== undefined || layer.config?.providers?.[providerId] !== undefined)?.path || paths.projectPath || null },
      custom: { exists: customExists, path: paths.customPath }
    }
  };
}

function removeProviderConfig(providerId, workingDirectory, scope = 'user') {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = layers.paths.userPath;
  const sources = getProviderSources(providerId, workingDirectory).sources;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = sources.project.path || targetPath;
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      return false;
    }
    targetPath = layers.paths.customPath;
  } else {
    targetPath = sources.user.path;
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const providerConfig = isPlainObject(targetConfig.provider) ? targetConfig.provider : {};
  const providersConfig = isPlainObject(targetConfig.providers) ? targetConfig.providers : {};
  const removedProvider = Object.prototype.hasOwnProperty.call(providerConfig, providerId);
  const removedProviders = Object.prototype.hasOwnProperty.call(providersConfig, providerId);

  if (!removedProvider && !removedProviders) {
    return false;
  }

  if (removedProvider) {
    delete providerConfig[providerId];
    if (Object.keys(providerConfig).length === 0) {
      delete targetConfig.provider;
    } else {
      targetConfig.provider = providerConfig;
    }
  }

  if (removedProviders) {
    delete providersConfig[providerId];
    if (Object.keys(providersConfig).length === 0) {
      delete targetConfig.providers;
    } else {
      targetConfig.providers = providersConfig;
    }
  }

  writeConfig(targetConfig, targetPath || CONFIG_FILE);
  console.log(`Removed provider ${providerId} from config: ${targetPath}`);
  return true;
}

/** Delete the provider from every physical document in the selected location. */
function removeProviderConfiguration(providerId, workingDirectory) {
  if (typeof providerId !== 'string' || !providerId.trim() || ['__proto__', 'constructor', 'prototype'].includes(providerId)) {
    throw new Error('Provider ID is required');
  }
  const layers = readConfigLayers(workingDirectory);
  let removed = false;
  const seen = new Set();
  for (const document of layers.documents) {
    if (seen.has(document.path)) continue;
    seen.add(document.path);
    const config = document.config;
    let changed = false;
    for (const key of ['provider', 'providers']) {
      if (!isPlainObject(config[key]) || !Object.hasOwn(config[key], providerId)) continue;
      delete config[key][providerId];
      if (!Object.keys(config[key]).length) delete config[key];
      changed = true;
    }
    if (changed) {
      writeConfig(config, document.path);
      removed = true;
    }
  }
  return removed;
}

export {
  getProviderSources,
  removeProviderConfig,
  removeProviderConfiguration,
};
