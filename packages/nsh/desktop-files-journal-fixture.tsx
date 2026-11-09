import { computed, host, mount, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { createNativeDesktopPanelTabs, NativeDesktopPanel } from './desktop-panel';
import { bindRequest } from './runtime';
import { app } from './state';
import { language } from './i18n';

/** Headless only. NSH MemoryStorage is authoritative for this synthetic engine;
 * its test sync is NOT a claim that production NSH FileStorage exposes fsync. */
function Fixture() {
  language.set('en');
  const hostScope = { hostID: 'host-a', lease: 'synthetic-journal-lease' };
  const authority = signal('synthetic-journal-authority'), failed = signal(false), flushed = signal('idle'), stats = signal('{}');
  const scope = computed(() => ({ host: hostScope, authorityKey: authority(), sessionID: 'session-a', directory: '/workspace' }));
  app.runtimeScope.set(hostScope);
  const tabs = createNativeDesktopPanelTabs({ storage: {
    keys: () => Storage.keys(), getItem: key => Storage.getItem(key),
    setItem: (key, value) => failed() ? Promise.reject(new Error('synthetic_storage_failed')) : Storage.setItem(key, value),
    removeItem: key => failed() ? Promise.reject(new Error('synthetic_storage_failed')) : Storage.removeItem(key),
    sync: async () => { if (failed()) throw new Error('synthetic_storage_failed'); },
  } });
  host.on('desktop-panel-fixture.stats', value => stats.set(JSON.stringify(value)));
  tabs.open(scope(), { kind: 'file', path: 'source.ts' });
  const control = (mode: string) => { void bindRequest(hostScope)('/fixture/control?fail=' + mode); };
  return <View class="flex-1">
    <View class="flex-row flex-wrap">
      <Button testID="fixture-journal-flush" onPress={() => { void tabs.editors.journal!.flush().then(value => flushed.set(String(value))); }}><Text>Checkpoint buffer</Text></Button>
      <Button testID="fixture-journal-fail" onPress={() => failed.set(!failed())}><Text>Toggle synthetic disk failure</Text></Button>
      <Button testID="fixture-journal-unknown" onPress={() => control('write-unknown')}><Text>Unknown write</Text></Button>
      <Button testID="fixture-journal-401" onPress={() => control('stat-401')}><Text>401 verification</Text></Button>
      <Button testID="fixture-journal-404" onPress={() => control('stat-404')}><Text>404 verification</Text></Button>
      <Button testID="fixture-journal-authority" onPress={() => authority.set('changed-authorization')}><Text>Change authorization</Text></Button>
      <Button testID="fixture-journal-open" onPress={() => tabs.open(scope(), { kind: 'file', path: 'source.ts' })}><Text>Open captured file</Text></Button>
    </View>
    <Text>{'journal-flushed:' + flushed()}</Text><Text>{'journal-state:' + JSON.stringify(tabs.journalState())}</Text><Text>{'journal-stats:' + stats()}</Text>
    <NativeDesktopPanel scope={scope()} current={() => true} active tabs={tabs} />
  </View>;
}
mount(Fixture);
