// CLI-only data fixture. No real Host settings are read or changed.
export function createHost() {
  return {
    call(name: string, input: { path?: string; method?: string; body?: unknown; expectedHost?: { hostID?: string; lease?: string } }) {
      if (name === 'connection.list') return {
        selected: 'fixture', runtimeScope: { hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000001' },
        connections: [{ id: 'fixture', url: 'https://host.example', label: 'Fixture', authorizationID: 'synthetic-appearance-authorization', lastUsedAt: 0 }],
      };
      if (name === 'appearance.reset') return { revision: 1 };
      if (name === 'appearance.apply') return { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'JetBrains Mono', dark: 'JetBrains Mono' }, unsupportedFonts: [] };
      if (name === 'runtime.request' && input.path === '/api/config/settings') {
        const scope = input.expectedHost;
        if (!scope || Object.keys(scope).sort().join(',') !== 'hostID,lease' || scope.hostID !== 'fixture' || scope.lease !== '00000000-0000-4000-8000-000000000001'
          || input.method !== 'GET' || input.body !== undefined) throw new Error('Unexpected appearance canonical read');
        return {
          status: 200,
          body: { themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false, fontSize: 120, uiFont: 'system', monoFont: 'system-mono' },
        };
      }
      throw new Error('Unexpected appearance fixture call');
    },
  };
}
