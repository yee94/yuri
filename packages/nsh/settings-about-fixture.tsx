import { cleanup, effect, mount, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { native } from './runtime';
import { SettingsAbout } from './settings-about';
import { createAboutDiagnosticsRoot } from './settings-about-diagnostics';
import { captureHostOperation } from './state';
import { admitSettingsFixture } from './settings-raw-fixture-bootstrap';

/** Explicit synthetic fixture only. Real root adoption of a synthetic snapshot; no credentials or real Host. */
language.set('en');
function AboutFixture() {
  const scope = () => { const operation = captureHostOperation(); return operation.current() && operation.scope ? { hostID: operation.scope.hostID, generation: operation.generation } : null; };
  const diagnostics = createAboutDiagnosticsRoot({ call: native, scope });
  cleanup(() => diagnostics.dispose());
  effect(() => { const admitted = scope(); untracked(() => { if (admitted) void diagnostics.refresh(); }); });
  const audit = signal(''), ready = signal(false), failure = signal('');
  void admitSettingsFixture().then(() => ready.set(true)).catch(() => failure.set('Fixture scope admission failed'));
  return <View class="flex-1 bg-background">
    <View class="gap-2 p-3">
      <Button testID="about-fixture-fail-info" onPress={() => { void native('about.fixture.scenario', { mode: 'fail-info' }); }}><Text>Fixture: fail Host info</Text></Button>
      <Button testID="about-fixture-missing" onPress={() => { void native('about.fixture.scenario', { mode: 'missing' }); }}><Text>Fixture: missing versions</Text></Button>
      <Button testID="about-fixture-export-failed" onPress={() => { void native('about.fixture.scenario', { mode: 'failed' }); }}><Text>Fixture: share failure</Text></Button>
      <Button testID="about-fixture-export-cancelled" onPress={() => { void native('about.fixture.scenario', { mode: 'cancelled' }); }}><Text>Fixture: share cancel</Text></Button>
      <Button testID="about-fixture-export-shared" onPress={() => { void native('about.fixture.scenario', { mode: 'shared' }); }}><Text>Fixture: share success</Text></Button>
      <Button testID="about-fixture-audit" onPress={() => { void native('about.fixture.audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Fixture: audit</Text></Button>
      <Button testID="about-fixture-event" onPress={() => { const captured = scope(); if (captured) diagnostics.onEvent({ key: 'global', type: 'session.status', directory: '/private-fixture-path', body: { sessionID: 'private-session', text: 'private-do-not-record' } }, captured); }}><Text>Fixture: runtime status</Text></Button>
      <Button testID="about-fixture-update-failed" onPress={() => { void native('about.fixture.scenario', { mode: 'update-failed' }); }}><Text>Fixture: update failure</Text></Button>
      <Button testID="about-fixture-update-succeeded" onPress={() => { void native('about.fixture.scenario', { mode: 'succeeded' }); }}><Text>Fixture: update success</Text></Button>
      <Text testID="about-fixture-audit-result">{audit()}</Text>
      <If when={!!failure()}><Text testID="about-fixture-admission-error">{failure()}</Text></If>
    </View>
    <If when={ready()}><Text testID="about-fixture-ready">Fixture scope admitted</Text><SettingsAbout active /></If>
  </View>;
}
mount(AboutFixture);
