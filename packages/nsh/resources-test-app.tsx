import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { ContactAttachmentPreview, ResourcePreview, ResourcesBrowser } from './resources';
import { language } from './i18n';
import { app } from './state';
function ResourcesTest() {
  language.set('en');
  app.runtimeScope.set(Object.freeze({ hostID: 'resource-fixture', lease: '00000000-0000-4000-8000-000000000001' }));
  const targeted = signal(false);
  const contact = signal(false), receipt = Object.freeze({ ...app.runtimeScope()! });
  const file = Object.freeze({ type: 'file' as const, kind: 'contact' as const, hostID: 'resource-fixture', assistantID: 'fixture-bot', attachmentID: 'opaque-note', sha256: 'a'.repeat(64), size: 26, mime: 'text/markdown', filename: 'note.md', name: 'note.md' });
  return <View class="flex-1"><Button testID="open-contact" onPress={() => contact.set(true)}><Text>Open contact attachment</Text></Button><Button testID="expire-contact" onPress={() => app.runtimeScope.set({ ...receipt, lease: '00000000-0000-4000-8000-000000000002' })}><Text>Expire contact receipt</Text></Button><Button testID="open-line-target" onPress={() => targeted.set(true)}><Text>Open line target</Text></Button><If when={contact()} else={<If when={targeted()} else={<ResourcesBrowser directory="/fixture" />}><ResourcePreview directory="/fixture" path="/fixture/lines.ts" targetLine={3} /></If>}><ContactAttachmentPreview file={file} expectedHost={receipt} active={contact()} onClose={() => contact.set(false)} /></If></View>;
}
mount(ResourcesTest);
