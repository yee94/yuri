import { mount, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { native } from './runtime';
import { SettingsGitHub } from './settings-github';
import { SettingsGitCredentials } from './settings-git-credentials';
import { admitSettingsFixture } from './settings-raw-fixture-bootstrap';

language.set('en');
function GitHubFixture() {
  const active = signal(true), audit = signal(''), ready = signal(false), failure = signal('');
  void admitSettingsFixture().then(() => ready.set(true)).catch(() => failure.set('Fixture scope admission failed'));
  return <Scroll class="flex-1 bg-background" contentClass="p-4 gap-4">
    <View class="gap-2">
      <Each of={['pending', 'connected', 'expired', 'denied', 'unknown', 'fail-read', 'slow']}>{mode => <Button testID={`github-fixture-${mode()}`} onPress={() => { void native('github.fixture.scenario', { mode: mode() }); }}><Text>{mode()}</Text></Button>}</Each>
      <Button testID="github-fixture-active" onPress={() => active.set(!active())}><Text>Fixture visibility</Text></Button>
      <Button testID="github-fixture-audit" onPress={() => { void native('github.fixture.audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Fixture audit</Text></Button>
      <Text testID="github-fixture-audit-result">{audit()}</Text>
      <If when={!!failure()}><Text testID="github-fixture-admission-error">{failure()}</Text></If>
    </View>
    <If when={ready()}><Text testID="github-fixture-ready">Fixture scope admitted</Text>
      <SettingsGitHub active={active()} open={url => native<boolean>('github.fixture.open', { url })} />
      <SettingsGitCredentials active={active()} id={() => 'synthetic-import'} />
    </If>
  </Scroll>;
}
mount(GitHubFixture);
