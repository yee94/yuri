import { mount, signal, View, Text } from 'nsh';
import { Button, NavPage, NavStack, createNavStack } from 'nsh/base';
import { ResourceFilesPage, ResourcePreviewPage } from './resource-navigation';
import { native } from './runtime';
import { app } from './state';
import { language } from './i18n';

/** Synthetic headless navigation only; no WK component, Host or device runs. */
function ResourceNavigationFixture() {
  language.set('en');
  const receipt = Object.freeze({ hostID: 'resource-route-fixture', lease: '00000000-0000-4000-8000-000000000001' });
  app.runtimeScope.set(receipt);
  const nav = createNavStack<'home' | 'files' | 'preview'>(['home']), audit = signal('');
  async function control(fixtureAction: string) { audit.set(JSON.stringify(await native('resources.present', { fixtureAction }))); }
  return <View class="flex-1">
    <View class="flex-row flex-wrap gap-2"><Button testID="route-open-files" onPress={() => nav.push('files')}><Text>Files</Text></Button><Button testID="route-open-preview" onPress={() => nav.push('preview')}><Text>Preview</Text></Button>
      <Button testID="route-fail-close" onPress={() => { void control('fail-next'); }}><Text>Fail close</Text></Button><Button testID="route-inspect" onPress={() => { void control('inspect'); }}><Text>Inspect</Text></Button><Button testID="route-release-close" onPress={() => { void control('release'); }}><Text>ACK close</Text></Button></View>
    <Text testID="route-audit">{audit()}</Text>
    <NavStack state={nav} class="flex-1">{route => route === 'home' ? <NavPage title="Synthetic resource navigation"><Text testID="route-home">Resource route home</Text></NavPage>
      : route === 'files' ? <ResourceFilesPage title="Files" directory="/fixture" path="/fixture/source.ts" expectedHost={receipt} active={nav.routes().at(-1) === route} onClose={() => nav.pop()} />
        : <ResourcePreviewPage title="source.ts" directory="/fixture" path="/fixture/source.ts" expectedHost={receipt} active={nav.routes().at(-1) === route} onClose={() => nav.pop()} />}</NavStack>
  </View>;
}
mount(ResourceNavigationFixture);
