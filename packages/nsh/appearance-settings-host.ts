import { createHost as baseHost } from './appearance-test-host';

export function createHost() {
  const base = baseHost();
  const systemColorScheme = 'light';
  let attempts = 0, reads = 0, confirmationReads = 0;
  let settings = { themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false, lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark', fontSize: 105, timeFormatPreference: '24h' };
  return {
    call(name: string, input: { path?: string; method?: string; body?: Record<string, unknown>; expectedHost?: { hostID?: string; lease?: string } }) {
      if (name === 'appearance.apply') return { ...base.call(name, input), systemColorScheme };
      if (name === 'connection.list') return {
        selected: 'fixture', runtimeScope: { hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000001' },
        connections: [{ id: 'fixture', url: 'https://host.example', label: 'Fixture', authorizationID: 'synthetic-appearance-authorization', lastUsedAt: 0 }],
      };
      if (name === 'runtime.request') {
        const scope = input.expectedHost;
        if (!scope || Object.keys(scope).sort().join(',') !== 'hostID,lease' || scope.hostID !== 'fixture' || scope.lease !== '00000000-0000-4000-8000-000000000001') throw new Error('Unexpected appearance runtime scope');
      }
      if (name === 'runtime.request' && input.path === '/api/config/settings') {
        if (input.method !== 'GET' && input.method !== 'PUT' || input.method === 'GET' && input.body !== undefined) throw new Error('Unexpected appearance settings method or read body');
        if (input.method === 'GET') { reads++; if (attempts) confirmationReads++; }
        if (input.method === 'PUT') {
          const body = input.body;
          if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'darkThemeId,lightThemeId,themeId,themeVariant,useSystemTheme'
            || body.lightThemeId !== 'jetbrains-light' || body.darkThemeId !== 'jetbrains-dark'
            || typeof body.useSystemTheme !== 'boolean' || body.themeVariant !== 'light' && body.themeVariant !== 'dark'
            || body.themeId !== (body.themeVariant === 'light' ? body.lightThemeId : body.darkThemeId)
            || body.useSystemTheme && body.themeVariant !== systemColorScheme) throw new Error('Appearance write lost canonical theme identity');
          attempts++;
          if (attempts === 1 && body.themeVariant === 'light' && body.useSystemTheme === false) return { status: 409, body: { error: 'raw-sensitive-appearance-save-sentinel' } };
          settings = { ...settings, ...body };
        }
        return { status: 200, body: settings };
      }
      if (name === 'runtime.request' && input.path === '/fixture/appearance/audit' && input.method === 'GET' && input.body === undefined) return { status: 200, body: { attempts, reads, confirmationReads, themeId: settings.themeId, themeVariant: settings.themeVariant, useSystemTheme: settings.useSystemTheme, lightThemeId: settings.lightThemeId, darkThemeId: settings.darkThemeId } };
      if (name === 'runtime.request' && input.path === '/api/config/themes' && input.method === 'GET' && input.body === undefined) return { status: 200, body: { themes: [] } };
      return base.call(name, input);
    },
  };
}
