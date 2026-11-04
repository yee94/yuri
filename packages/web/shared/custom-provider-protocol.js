export const customProviderProtocols = [
  { label: 'OpenAI Chat Completions', package: '@opencode/ai/providers/openai-compatible', version: 'v1', path: '/chat/completions' },
  { label: 'OpenAI Responses', package: '@opencode/ai/providers/openai-compatible/responses', version: 'v1', path: '/responses' },
  { label: 'Anthropic Messages', package: '@opencode/ai/providers/anthropic-compatible', version: 'v1', path: '/messages' },
  { label: 'Google Gemini', package: '@opencode/ai/providers/google', version: 'v1beta', path: '/models/{model}:streamGenerateContent?alt=sse' },
];

/** Cherry semantics: trim `/`, infer a missing version, and use a trailing `#` to suppress inference. */
export function resolveCustomProviderURL(value, pkg, modelID = '{model}') {
  const protocol = customProviderProtocols.find((entry) => entry.package === pkg);
  if (!protocol || typeof value !== 'string' || !value.trim() || value.includes('\\')) return null;
  let baseURL = value.trim().replace(/\/+$/, '');
  const exact = baseURL.endsWith('#');
  if (exact) baseURL = baseURL.slice(0, -1).replace(/\/+$/, '');
  try {
    const url = new URL(baseURL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (exact && !protocol.path.includes('{model}') && baseURL.endsWith(protocol.path)) {
      baseURL = baseURL.slice(0, -protocol.path.length);
    } else if (!exact && !/\/v\d+(?:alpha|beta)?(?:\/|$)/i.test(url.pathname)) {
      baseURL += `/${protocol.version}`;
    }
    return {
      baseURL,
      requestURL: `${baseURL}${protocol.path.replace('{model}', modelID || '{model}')}`,
      modelsURL: `${baseURL}/models`,
      inferredVersion: !exact && !/\/v\d+(?:alpha|beta)?(?:\/|$)/i.test(url.pathname),
    };
  } catch {
    return null;
  }
}
