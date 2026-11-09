import { cleanup, computed, host, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { app } from '../../state';
import { language } from '../../i18n';
import { createNativeDesktopPanelTabs, NativeDesktopPanel } from '../../desktop-panel';
import { NativeDesktopChanges } from '../../desktop-panel-changes';
import { createDesktopDiffPreferences, type DesktopDiffPreferencesPort } from '../../desktop-diff-preferences-core';
import type { ChangesSource } from '../../chat-changes-model';
import type { DesktopPanelScope } from '../../desktop-panel-model';

/** Synthetic native adapter only: real panel/Changes consumers, no App or Host. */
function Adapter() {
  language.set('en');
  const mode = String(host.params.mode ?? 'panel');
  const scope: DesktopPanelScope = { host: { hostID: 'adapter', lease: 'adapter-lease' }, authorityKey: 'adapter-authority', sessionID: 'parent', directory: '/workspace' };
  app.runtimeScope.set(scope.host);
  const active = signal(true), authority = signal(true), modal = signal(false), draft = signal(''), prefRevision = signal(0), invalidation = signal(0);
  const storage = new Map<string, string>();
  const preferences = createDesktopDiffPreferences({ getItem: async key => storage.get(key) ?? null, setItem: async (key, value) => { storage.set(key, value); } }, () => prefRevision.set(prefRevision() + 1));
  void preferences.load().then(() => preferences.setFileLayout(['z.ts'], 'side-by-side'));
  const port: DesktopDiffPreferencesPort = {
    preferences(path) { prefRevision(); return preferences.preferences(path); },
    available() { prefRevision(); return preferences.available(); },
    setFileLayout: preferences.setFileLayout, setWrapLines: preferences.setWrapLines,
  };
  const tabs = createNativeDesktopPanelTabs({ storage: false });
  const history: Extract<ChangesSource, { kind: 'turn' }> = { kind: 'turn', directory: '/workspace', sessionID: mode === 'single' ? 'exact-child' : 'parent', messageID: 'exact-user', path: mode === 'thin' ? 'thin.ts' : 'z.ts', targetLine: 2, files: [
    { path: 'z.ts', before: 'SAME\nHISTORY_BEFORE\nTAIL', after: 'SAME\nHISTORY_AFTER\nTAIL' },
    { path: 'a.ts', before: 'A_BEFORE', after: 'A_HISTORY' },
    { path: 'thin.ts' },
  ], loadFile: async () => { throw new Error('exact resolver unavailable'); } };
  const source: ChangesSource = mode === 'single' || mode === 'thin' ? history : { kind: 'workspace', directory: '/workspace', ...(host.params.noPath ? {} : { path: 'z.ts', targetLine: 2 }) };
  if (mode !== 'catalog') {
    if (mode === 'single') tabs.open(scope, { kind: 'file-diff', source: { ...history, path: 'z.ts', files: history.files.filter(file => file.path !== 'thin.ts') } });
    else tabs.open(scope, { kind: 'diff', source });
    tabs.setRail(scope, null);
  }
  const selected = computed(() => tabs.snapshot(scope).selectedID);
  const off = host.on<{ action: string }>('diff.adapter.control', event => {
    if (event.action === 'active') active.set(!active());
    if (event.action === 'modal') modal.set(!modal());
    if (event.action === 'authority') authority.set(false);
    if (event.action === 'source') tabs.open(scope, { kind: 'diff', source: history });
    if (event.action === 'invalidate') invalidation.set(invalidation() + 1);
    if (event.action === 'close') { const id = selected(); if (id) void tabs.close(scope, id); }
  });
  cleanup(off);
  return <View class="flex-1">
    <Input testID="diff-adapter-composer" value={draft()} onChange={event => draft.set(event.value)} />
    <Text>{'adapter-selected:' + selected()}</Text>
    <If when={mode !== 'catalog'}><NativeDesktopPanel scope={scope} current={authority} active={active()} modalOpen={modal()} tabs={tabs} diffPreferences={port} /></If>
    <If when={mode === 'catalog'}><NativeDesktopChanges scope={scope} source={source} active={active() && !modal()} current={authority} refreshRevision={invalidation()}
      files={[{ path: 'z.ts', staged: false, status: 'M' }, { path: 'a.ts', staged: false, status: 'M' }, { path: 'z.ts', staged: true, status: 'M' }]}
      preferences={port.preferences()} filePreferences={path => port.preferences(path)} onOpenFile={() => {}} onOpenDiff={() => {}} /></If>
    <Text>adapter-ready</Text>
  </View>;
}
mount(Adapter);
