import { cleanup, computed, host, mount, signal, Storage, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { app, loadConnections } from './state';
import { language } from './i18n';
import { createNativeDesktopPanelTabs, NativeDesktopPanel } from './desktop-panel';
import { SettingsPreferences } from './settings-preferences';
import { bindNativeDesktopDiffPreferences, createNativeDesktopDiffPreferences, nativeDesktopDiffPreferences } from './desktop-diff-preferences';
import { DESKTOP_DIFF_PREFERENCES_KEY } from './desktop-diff-preferences-core';

function Workbench() {
  language.set('en');
  let reads = 0, writes = 0, failReads = 0, loseAck = false, auditRevision = 0, holdWrite = false;
  let releaseWrite: (() => void) | undefined;
  const preferences = createNativeDesktopDiffPreferences({ coordination: host.params.multiEngine ? 'multi-engine' : 'single-engine', storage: {
    getItem: async key => { reads++; if (failReads) { failReads--; throw new Error('synthetic read failure'); } return Storage.getItem(key); },
    setItem: async (key, value) => { writes++; if (holdWrite) await new Promise<void>(done => { releaseWrite = done; }); await Storage.setItem(key, value); if (loseAck) { loseAck = false; failReads = 1; throw new Error('synthetic ACK lost'); } },
  } });
  cleanup(bindNativeDesktopDiffPreferences(preferences));
  const settings = signal(true), directory = signal('/parent'), input = signal(''), audit = signal(''), result = signal('');
  const scope = computed(() => ({ host: app.runtimeScope()!, authorityKey: 'authority-A', sessionID: directory() === '/parent' ? 'parent' : 'second', directory: directory() }));
  const tabs = createNativeDesktopPanelTabs({ storage: false });
  const openDiff = () => { tabs.open(scope(), { kind: 'diff', source: { kind: 'workspace', directory: directory(), path: directory() === '/parent' ? 'a.ts' : 'b.ts' } }); tabs.setRail(scope(), null); };
  openDiff();
  cleanup(host.on('diff-preferences.control', payload => {
    const action = (payload as { action: string }).action;
    if (action === 'panel') settings.set(false);
    if (action === 'settings') settings.set(true);
    if (action === 'scope') { directory.set('/second'); openDiff(); settings.set(false); }
    if (action === 'file-diff') { tabs.open(scope(), { kind: 'file-diff', source: { kind: 'turn', directory: '/other', sessionID: 'child', messageID: 'tool', path: 'history.ts', files: [{ path: 'history.ts', before: 'SAME\nBEFORE_HISTORY\nTAIL', after: 'SAME\nAFTER_HISTORY\nTAIL' }] } }); settings.set(false); }
    if (action === 'fail-preflight') failReads = 1;
    if (action === 'lose-ack') loseAck = true;
    if (action === 'hold-write') holdWrite = true;
    if (action === 'release-write') { holdWrite = false; releaseWrite?.(); releaseWrite = undefined; }
    if (action === 'duplicate') { try { bindNativeDesktopDiffPreferences(preferences); result.set('duplicate:accepted'); } catch { result.set('duplicate:rejected'); } }
    if (action === 'retry') { void preferences.retry().then(value => result.set('retry:' + value)); }
    if (action === 'flush') { void preferences.flush().then(value => result.set('flush:' + value)); }
    if (action === 'restore-valid') { void Storage.setItem(DESKTOP_DIFF_PREFERENCES_KEY, JSON.stringify({ version: 1, layoutPreference: 'dynamic', wrapLines: false })).then(() => preferences.retry()).then(value => result.set('retry:' + value)); }
    if (action === 'audit') audit.set(JSON.stringify({ serial: ++auditRevision, reads, writes, state: preferences.state(), canClose: preferences.canClose(), sameOwner: nativeDesktopDiffPreferences() === preferences,
      available: preferences.available(), fileCount: preferences.fileCount(), a: preferences.preferences('a.ts'), b: preferences.preferences('b.ts'), tabs: tabs.snapshot(scope()) }));
  }));
  return <View class="flex-1"><Input testID="diff-preferences-input" value={input()} onChange={event => input.set(event.value)} /><Text>{'diff-pref-audit:' + audit()}</Text><Text>{'diff-pref-result:' + result()}</Text>
    <If when={settings()}><SettingsPreferences page="chat" target="chat.diff-layout" onOpen={() => {}} onBack={() => {}} onConnect={() => {}} /></If>
    <View class="flex-1" style={{ display: settings() ? 'none' : 'flex' }}><NativeDesktopPanel scope={scope()} tabs={tabs} active={!settings()} current={() => app.runtimeScope()?.hostID === 'A'} diffPreferences={preferences} /></View>
  </View>;
}
function Fixture() { const ready = signal(false); void loadConnections().then(() => ready.set(true)); return <View class="flex-1"><If when={ready()}><Workbench /></If></View>; }
mount(Fixture);
