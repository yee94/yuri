import { cleanup, computed, host, mount, openUrl, signal, View } from 'nsh';
import { NativeDesktopTerminalDock } from './desktop-terminal';
import { createDesktopTerminalPreview } from './desktop-terminal-preview';
import { NativeDesktopBrowserPane } from './desktop-browser';
import { createDesktopPanelTabs, type DesktopPanelScope } from './desktop-panel-model';
import { appearanceFromSettings } from './appearance-core';
import { nativeAppearance, nativeCodeFontSize } from './appearance';
import { language } from './i18n';

// Actual Dock + production preview factory + panel tabs + native browser pane.
// Rust supplies synthetic native terminal events through EngineControl only;
// there is no application import, window, Vault, real network or PTY.
function Fixture() {
  language.set('en');
  const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: '00000000-0000-4000-8000-000000000007' }, authorityKey: 'synthetic-authorization', sessionID: 'synthetic-session', directory: '/synthetic' };
  const active = signal(true), revision = signal(0);
  const tabs = createDesktopPanelTabs(() => revision.set(revision() + 1));
  const selected = computed(() => { revision(); const state = tabs.snapshot(scope); return state.tabs.find(tab => tab.id === state.selectedID); });
  const browserURL = () => { const tab = selected(); return tab?.kind === 'browser' ? tab.url : ''; };
  const openPreview = createDesktopTerminalPreview({ scope: () => scope, active,
    openPanel: (captured, url) => { tabs.open(captured, { kind: 'browser', url }); return true; },
    openExternal: openUrl,
  });
  cleanup(host.on('fixture.active', value => active.set(value === true)));
  void appearanceFromSettings({}, async () => []).then(appearance => {
    nativeCodeFontSize.set(100);
    nativeAppearance.current.set({ ...appearance, uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [], sourceHost: { hostID: scope.host.hostID, generation: 1, url: 'https://synthetic.invalid' } });
  });
  return <View style={{ width: 1000, height: 700 }}>
    <View style={{ height: 300 }}><NativeDesktopTerminalDock scope={scope.host} directory={scope.directory} current={() => true} active={active()} expanded={false} onToggleExpanded={() => {}} onClose={() => active.set(false)} onOpenPreview={openPreview} /></View>
    <If when={selected()?.kind === 'browser'}><NativeDesktopBrowserPane scope={scope} current={() => true} active={active()} intent={{ kind: 'browser', url: browserURL() }} /></If>
  </View>;
}
mount(Fixture);
