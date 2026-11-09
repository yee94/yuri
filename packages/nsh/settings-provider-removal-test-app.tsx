import { mount, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { SettingsProviders } from './settings-providers';
import { settingsAction } from './settings-controls';
import { settingsEngineFixtureBoot } from './settings-engine-fixture-boot';

language.set('en');
type Route = { kind: 'home' } | { kind: 'providers'; directory?: string; entity?: string; create?: boolean };
function ProviderRemovalTestApp() {
  const boot = settingsEngineFixtureBoot();
  const nav = createNavStack<Route>([{ kind: 'home' }]);
  return <If when={boot.mounted()}><NavStack state={nav} class="flex-1">{route => route.kind === 'home'
    ? <NavPage title="Provider removal fixture" class="flex-1"><View class="p-5 gap-4">
      <Button testID="provider-fixture-global" class={settingsAction} onPress={() => nav.push({ kind: 'providers' })}><Text>Global provider fixture</Text></Button>
      <Button testID="provider-fixture-scoped" class={settingsAction} onPress={() => nav.push({ kind: 'providers', directory: '/fixture/project' })}><Text>Scoped provider fixture</Text></Button>
    </View></NavPage>
    : <NavPage title="Providers" headerBackTitle="" class="flex-1"><SettingsProviders page="providers" entity={route.entity} create={route.create} directory={route.directory} active={boot.active() && nav.routes().at(-1) === route}
      onOpen={next => nav.push({ kind: 'providers', directory: route.directory, entity: next.entity, create: next.create })} onBack={() => nav.pop()} onConnect={() => undefined} /></NavPage>}</NavStack></If>;
}
mount(ProviderRemovalTestApp);
