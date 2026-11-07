import { createHost as baseHost } from './appearance-test-host';

export function createHost() {
  const base = baseHost();
  let attempts = 0;
  let settings = { themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false, lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark', fontSize: 105, timeFormatPreference: '24h' };
  return {
    call(name: string, input: { path?: string; method?: string; body?: Record<string, unknown>; expectedHost?: { hostID?: string; lease?: string } }) {
      if (name === 'runtime.request') {
        const scope = input.expectedHost;
        if (!scope || Object.keys(scope).sort().join(',') !== 'hostID,lease' || scope.hostID !== 'fixture' || scope.lease !== '00000000-0000-4000-8000-000000000001') throw new Error('Unexpected appearance runtime scope');
      }
      if (name === 'runtime.request' && input.path === '/api/config/settings') {
        if (input.method === 'PUT') {
          const body = input.body;
          if (!body || Object.keys(body).sort().join(',') !== 'darkThemeId,lightThemeId,themeId,themeVariant,useSystemTheme' || body.lightThemeId !== 'jetbrains-light' || body.darkThemeId !== 'jetbrains-dark') throw new Error('Appearance write lost canonical theme identity');
          attempts++;
          if (attempts === 1) return { status: 409, body: { error: 'raw-sensitive-appearance-save-sentinel' } };
          settings = { ...settings, ...body };
        }
        return { status: 200, body: settings };
      }
      return base.call(name, input);
    },
  };
}
