import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { ResourcePreview, ResourcesBrowser } from './resources';
import { language } from './i18n';
import { app } from './state';
function ResourcesTest() {
  language.set('en');
  app.runtimeScope.set(Object.freeze({ hostID: 'resource-fixture', lease: '00000000-0000-4000-8000-000000000001' }));
  const targeted = signal(false);
  return <View class="flex-1"><Button testID="open-line-target" onPress={() => targeted.set(true)}><Text>Open line target</Text></Button><If when={targeted()} else={<ResourcesBrowser directory="/fixture" />}><ResourcePreview directory="/fixture" path="/fixture/lines.ts" targetLine={3} /></If></View>;
}
mount(ResourcesTest);
