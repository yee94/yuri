import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { native } from './runtime';
import { SettingsCollection } from './settings-collections';
import type { SettingsRoute } from './settings';
import { admitSettingsFixture } from './settings-raw-fixture-bootstrap';

/** Isolated production-component fixture, never mounted by App/application. */
language.set('en');
function CollectionsFixture() {
  const nav = createNavStack<SettingsRoute>([{ page: 'agents' }]), audit = signal('');
  const ready = signal(false);
  void admitSettingsFixture().then(() => ready.set(true), failure => audit.set(String(failure)));
  const callbacks = { onOpen: (route: SettingsRoute) => nav.push(route), onBack: () => nav.pop(), onConnect: () => undefined };
  return <View class="flex-1 bg-background">
    <View class="gap-2 p-3">
      <Button testID="collections-fixture-mcp" onPress={() => nav.push({ page: 'mcp', create: true })}><Text>MCP fixture</Text></Button>
      <Button testID="collections-fixture-plugins" onPress={() => nav.push({ page: 'plugins' })}><Text>Plugins fixture</Text></Button>
      <Button testID="collections-fixture-audit" onPress={() => { void native<Record<string, number>>('collections.fixture.audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Audit fixture</Text></Button>
      <Text testID="collections-fixture-audit-result">{audit()}</Text>
    </View>
    <If when={ready()}><NavStack state={nav} class="flex-1">{route => <NavPage title="Collections fixture" class="flex-1"><SettingsCollection {...callbacks} {...route} directory="/fixture/project" /></NavPage>}</NavStack></If>
  </View>;
}
mount(CollectionsFixture);
