export function createHost() {
  return { call(name, input) {
    if (name !== 'runtime.request') return true;
    if (input.method !== 'GET') throw new Error('Features navigation fixture must not write');
    if (input.path === '/api/config/settings') return { status: 200, body: { favoriteModels: [], recentModels: [], hiddenModels: [], providerOrder: [], weekStartPreference: 'monday' } };
    const providerName = input.path === '/api/config/catalog/providers?directory=%2Fmanaged'
      ? 'Managed directory verified'
      : input.path === '/api/config/catalog/providers?directory=%2Ffirst-project'
        ? 'Task directory verified'
        : null;
    if (providerName) return { status: 200, body: { schemaVersion: 1, providers: [{ id: 'fixture', name: providerName, models: { model: { id: 'model', name: 'Model', variants: {} } } }] } };
    if (input.path === '/api/agent?location%5Bdirectory%5D=%2Ffirst-project') return { status: 200, body: { data: [{ id: 'build', name: 'build' }] } };
    throw new Error(`Unexpected features fixture request: ${input.path}`);
  } };
}
