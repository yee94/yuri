import { computed, host, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { app } from './state';
import { language } from './i18n';
import { bindRequest } from './runtime';
import { createNativeDesktopPanelTabs, NativeDesktopPanel } from './desktop-panel';
import type { DesktopPanelScope } from './desktop-panel-model';
import { nativeCodeFontSize } from './appearance';

/** Isolated headless fixture, never imported by App/application. */
function Fixture() {
  language.set('en');
  const hostScope = signal({ hostID: 'host-a', lease: 'fixture-lease-a' }), session = signal('session-a'), directory = signal('/workspace'), active = signal(true);
  app.runtimeScope.set(hostScope());
  const storage = new Map<string, string>();
  const tabs = createNativeDesktopPanelTabs({ storage: { keys: async () => [...storage.keys()], getItem: async key => storage.get(key) ?? null, setItem: async (key, value) => { storage.set(key, value); }, removeItem: async key => { storage.delete(key); }, sync: async () => {} } }), stats = signal('{}'), expanded = signal(false), headerControls = signal(false), windowClose = signal('idle'), panelWidth = signal<number | undefined>(undefined), modalOpen = signal(false), browserResult = signal('idle'), directSave = signal('idle');
  host.on('desktop-panel-fixture.stats', value => stats.set(JSON.stringify(value)));
  const scope = computed<DesktopPanelScope>(() => ({ host: hostScope(), authorityKey: hostScope().hostID + '-authority', sessionID: session(), directory: directory() }));
  const control = (name: string) => { void bindRequest(hostScope())('/fixture/control?fail=' + name); };
  function switchHost() { const next = hostScope().hostID === 'host-a' ? { hostID: 'host-b', lease: 'fixture-lease-b' } : { hostID: 'host-a', lease: 'fixture-lease-a' }; hostScope.set(next); app.runtimeScope.set(next); }
  return <View class="flex-1">
    <View class="flex-row flex-wrap gap-1">
      <Button testID="fixture-file" onPress={() => tabs.open(scope(), { kind: 'file', path: 'source.ts' })}><Text>File</Text></Button>
      <Button testID="fixture-file-other" onPress={() => tabs.open(scope(), { kind: 'file', path: 'other.ts' })}><Text>Other file</Text></Button>
      <Button testID="fixture-file-unsafe" onPress={() => tabs.open(scope(), { kind: 'file', path: 'unsafe.bin' })}><Text>Unsafe file</Text></Button>
      <Button testID="fixture-owner-close" onPress={() => { const id = tabs.snapshot(scope()).selectedID; if (id) void tabs.close(scope(), id); }}><Text>Owner close</Text></Button>
      <Button testID="fixture-owner-dispose" onPress={() => { void tabs.requestDispose(); }}><Text>Owner dispose</Text></Button>
      <Button testID="fixture-window-close" onPress={() => { void tabs.requestWindowClose().then(result => windowClose.set(String(result))); }}><Text>Window close guard</Text></Button>
      <Button testID="fixture-window-check" onPress={() => windowClose.set(String(tabs.canWindowClose()))}><Text>Window final check</Text></Button>
      <Button testID="fixture-narrow" onPress={() => panelWidth.set(320)}><Text>Narrow panel</Text></Button>
      <Button testID="fixture-wide" onPress={() => panelWidth.set(960)}><Text>Wide panel</Text></Button>
      <Button testID="fixture-preview" onPress={() => tabs.open(scope(), { kind: 'file', path: 'index.html' })}><Text>HTML preview</Text></Button>
      <Button testID="fixture-browser" onPress={() => tabs.open(scope(), { kind: 'browser', url: 'http://localhost:3000/' })}><Text>Browser</Text></Button>
      <Button testID="fixture-browser-request" onPress={() => browserResult.set(String(tabs.requestBrowser(scope(), tabs.snapshot(scope()).selectedID ?? '', { kind: 'browser', url: 'https://example.invalid/other' })))}><Text>Exact browser request</Text></Button>
      <Button testID="fixture-modal" onPress={() => modalOpen.set(!modalOpen())}><Text>Shell modal</Text></Button>
      <Button testID="fixture-editor-save-direct" onPress={() => { const tab = tabs.snapshot(scope()).tabs.find(tab => tab.id === tabs.snapshot(scope()).selectedID), document = tab?.kind === 'file' ? tabs.editors.model.peek(scope(), tab.path) : undefined; if (document) void tabs.editors.save(document).then(value => directSave.set(String(value))); }}><Text>Bound editor save</Text></Button>
      <Button testID="fixture-font" onPress={() => nativeCodeFontSize.set(nativeCodeFontSize() === 150 ? 100 : 150)}><Text>Code font scale</Text></Button>
      <Button testID="fixture-header-controls" onPress={() => headerControls.set(true)}><Text>Header controls</Text></Button>
      <Button testID="fixture-workspace" onPress={() => tabs.open(scope(), { kind: 'diff', source: { kind: 'workspace', directory: directory(), path: 'source.ts' } })}><Text>Workspace</Text></Button>
      <Button testID="fixture-staged" onPress={() => tabs.open(scope(), { kind: 'diff', source: { kind: 'workspace', directory: directory(), path: 'source.ts', staged: true } })}><Text>Staged</Text></Button>
      <Button testID="fixture-history" onPress={() => tabs.open(scope(), { kind: 'diff', source: { kind: 'turn', directory: directory(), sessionID: session(), messageID: 'message-a', path: 'source.ts', files: [{ path: 'source.ts', before: 'before', after: 'HISTORICAL_ONLY' }] } })}><Text>History</Text></Button>
      <Button testID="fixture-thin" onPress={() => tabs.open(scope(), { kind: 'diff', source: { kind: 'turn', directory: directory(), sessionID: session(), messageID: 'message-a', path: 'thin.ts', files: [{ path: 'thin.ts' }] } })}><Text>Thin history</Text></Button>
      <Button testID="fixture-session" onPress={() => session.set(session() === 'session-a' ? 'session-b' : 'session-a')}><Text>Session</Text></Button>
      <Button testID="fixture-directory" onPress={() => directory.set(directory() === '/workspace' ? '/worktree' : '/workspace')}><Text>Directory</Text></Button>
      <Button testID="fixture-host" onPress={switchHost}><Text>Host</Text></Button>
      <Button testID="fixture-hide" onPress={() => active.set(!active())}><Text>Visibility</Text></Button>
      <Button testID="fixture-fail-status" onPress={() => control('status')}><Text>Fail status</Text></Button>
      <Button testID="fixture-fail-diff" onPress={() => control('diff')}><Text>Fail diff</Text></Button>
      <Button testID="fixture-fail-file" onPress={() => control('file')}><Text>Fail file</Text></Button>
      <Button testID="fixture-delay-write" onPress={() => control('write-delayed')}><Text>Delay write</Text></Button>
      <Button testID="fixture-reject-write" onPress={() => control('write-rejected')}><Text>Reject write</Text></Button>
      <Button testID="fixture-unknown-write" onPress={() => control('write-unknown')}><Text>Unknown write</Text></Button>
      <Button testID="fixture-external" onPress={() => control('external')}><Text>External change</Text></Button>
      <Button testID="fixture-delay-git" onPress={() => control('git-delayed')}><Text>Delay Git</Text></Button>
      <Button testID="fixture-delay-mutation" onPress={() => control('mutation-delayed')}><Text>Delay mutation</Text></Button>
    </View>
    <Text>{'panel-state:' + JSON.stringify({ count: tabs.snapshot(scope()).tabs.length, selected: tabs.snapshot(scope()).selectedID, session: session(), host: hostScope().hostID, directory: directory(), active: active(), expanded: expanded(), modal: tabs.modalOpen() })}</Text>
    <Text>{'panel-stats:' + stats()}</Text>
    <Text>{'window-close:' + windowClose()}</Text>
    <Text>{'browser-result:' + browserResult()}</Text>
    <Text>{'editor-save-result:' + directSave()}</Text>
    <View class="flex-1" style={{ width: panelWidth() }}><NativeDesktopPanel scope={scope()} current={() => app.runtimeScope()?.hostID === hostScope().hostID} active={active()} tabs={tabs} modalOpen={modalOpen()} expanded={expanded()} onToggleExpanded={headerControls() ? () => expanded.set(!expanded()) : undefined} onClose={headerControls() ? () => active.set(false) : undefined} context={(captured, demand) => <View class="flex-1"><Text>{'REAL_CONTEXT:' + captured.sessionID}</Text><Text>{'context-demand:' + demand()}</Text></View>} /></View>
  </View>;
}
mount(Fixture);
