const secretField = /^(?:api[_-]?key|password|secret|token|access[_-]?token|refresh[_-]?token|authorization|credentials?|clientToken|headers|env)$/i;

/** Config directories are read-only views, not a path to remote provider/MCP secrets. */
export function projectRemoteConfiguration(value) {
  if (Array.isArray(value)) return value.map(projectRemoteConfiguration);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !secretField.test(name)).map(([name, child]) => [name, projectRemoteConfiguration(child)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) { url.username = ''; url.password = ''; return url.toString(); }
    } catch { /* Non-URL text stays display metadata. */ }
  }
  return value;
}
