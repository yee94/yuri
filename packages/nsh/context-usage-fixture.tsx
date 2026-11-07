import { host, mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { NativeContextUsagePage, type ContextUsageSource } from './context-usage';
import { contextUsageFixtureScope } from './context-usage-fixture-data';
import { contextUsageSnapshotFrom } from './context-usage-core';
import { language } from './i18n';
import dark from '../ui/src/lib/theme/themes/yuri-2-dark.json';

const nav = createNavStack<'root' | 'overview'>(['root', 'overview']);
/** Production component with canonical, raw synthetic root-owner snapshots. No main WebView. */
function Fixture() {
  language.set('en');
  const source = signal<ContextUsageSource>({ kind: 'loading' }), showTps = signal(true);
  async function load() {
    source.set({ kind: 'loading' });
    try { source.set({ kind: 'snapshot', value: contextUsageSnapshotFrom(await host.call('contextUsage.fixture.snapshot', {})) }); }
    catch (failure) { source.set({ kind: 'error', error: String(failure) }); }
  }
  void load();
  return <View class="flex-1 bg-background"><NavStack state={nav} class="flex-1">{route => route === 'root' ? <NavPage title="Synthetic root"><Button testID="context-usage-fixture-open" onPress={() => nav.push('overview')}><Text>Open overview fixture</Text></Button></NavPage> : <NativeContextUsagePage scope={contextUsageFixtureScope} source={source()} active={nav.routes().at(-1) === 'overview'} current={() => true} showAssistantTps={showTps()} locale="en-US" timeFormat="24h" palette={{ primary: dark.colors.primary.base, warning: dark.colors.status.warning, success: dark.colors.status.success, muted: dark.colors.surface.mutedForeground, subtle: dark.colors.surface.subtle }} onRetry={() => { void load(); }} />}</NavStack>
    <Button testID="context-usage-fixture-fail" onPress={() => source.set({ kind: 'error', error: 'Synthetic authority refresh failed' })}><Text>Fail synthetic refresh</Text></Button>
    <Button testID="context-usage-fixture-empty" onPress={() => { void host.call('contextUsage.fixture.empty', {}).then(value => source.set({ kind: 'snapshot', value: contextUsageSnapshotFrom(value) })); }}><Text>Successful empty snapshot</Text></Button>
    <Button testID="context-usage-fixture-tps" onPress={() => showTps.set(!showTps())}><Text>Toggle synthetic TPS preference</Text></Button>
  </View>;
}
mount(Fixture);
