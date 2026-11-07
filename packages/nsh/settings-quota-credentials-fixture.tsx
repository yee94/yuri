import { mount, signal, Text, untracked, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { native } from './runtime';
import { SettingsQuotaCredentials, SettingsQuotaCredentialsPage } from './settings-quota-credentials';
import { quotaCredentialResponse, type QuotaCredentialProvider, type QuotaCredentialRequest } from './settings-quota-credentials-core';

/** Synthetic-only production component fixture; no connection bootstrap or real Host. */
language.set('en');
function QuotaFixture() {
  const nav = createNavStack<{ providerId?: QuotaCredentialProvider }>([{}]);
  const audit = signal(''), active = signal(true), hostScope = signal(0);
  const send: QuotaCredentialRequest = async (path, method = 'GET', body) => quotaCredentialResponse(await native('runtime.request', { path, method, ...(body === undefined ? {} : { body }) }));
  const providers: QuotaCredentialProvider[] = ['opencode-go', 'ollama-cloud', 'cursor'];
  return <View class="flex-1 bg-background">
    <View class="gap-1 p-2">
      <Each of={['ok', 'read-fail', 'reject', 'lost-ack', 'invalid-ack', 'invalid-validation']}>{mode => <Button testID={`quota-fixture-${mode()}`} onPress={() => { void native('quota.fixture.scenario', { mode: mode() }); }}><Text>{mode()}</Text></Button>}</Each>
      <Button testID="quota-fixture-active" onPress={() => active.set(!active())}><Text>Fixture visibility</Text></Button>
      <Button testID="quota-fixture-host" onPress={() => hostScope.set(hostScope() + 1)}><Text>Fixture Host switch</Text></Button>
      <Button testID="quota-fixture-audit" onPress={() => { void native('quota.fixture.audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Fixture audit</Text></Button>
      <Text testID="quota-fixture-audit-result">{audit()}</Text>
    </View>
    <NavStack state={nav} class="flex-1">{(route, index) => {
      const capturedScope = untracked(() => hostScope());
      const dependencies = { send, current: () => hostScope() === capturedScope };
      return route.providerId
        ? <SettingsQuotaCredentialsPage providerId={route.providerId} providerName={route.providerId} directory="/fixture/project"
          active={active() && index() === nav.routes().length - 1} dependencies={dependencies} onBack={() => nav.pop()} />
        : <NavPage title="Quota fixture" class="flex-1"><Each of={providers}>{provider => <SettingsQuotaCredentials providerId={provider()} providerName={provider()}
          directory="/fixture/project" active={active() && index() === nav.routes().length - 1} dependencies={dependencies} onManage={() => nav.push({ providerId: provider() })} />}</Each></NavPage>;
    }}</NavStack>
  </View>;
}
mount(QuotaFixture);
