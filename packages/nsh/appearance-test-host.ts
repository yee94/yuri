// CLI-only data fixture. No real Host settings are read or changed.
export function createHost() {
  return {
    call(name: string, input: { path?: string }) {
      if (name === 'appearance.reset') return { revision: 1 };
      if (name === 'appearance.apply') return { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'JetBrains Mono', dark: 'JetBrains Mono' }, unsupportedFonts: [] };
      if (name === 'runtime.request' && input.path === '/api/config/settings') return {
        status: 200,
        body: { themeId: 'jetbrains-dark', themeVariant: 'dark', useSystemTheme: false, fontSize: 120, uiFont: 'system', monoFont: 'system-mono' },
      };
      throw new Error('Unexpected appearance fixture call');
    },
  };
}
