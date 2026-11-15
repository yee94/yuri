import { computed, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { messageFrom } from './model';
import { nativeBodyRows } from './transcript-body-model';
import { NativeTranscriptBody } from './transcript-body';
import { createActivityMaterializer } from './transcript-materialization';
import { app } from './state';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAA3UlEQVR4nO3QMQ0CAQBFsfOCDWzghRkvOGDBBjYwgQeW9y9pUgU9Lo/X6Xzf19M58jXRu/I10btEixady9dE7xItWnQuXxO9S7Ro0bl8TfQu0aJF5/I10btEixady9dE7xItWnQuXxO9S7Ro0bl8TfQu0aJF5/I10btEixady9dE7zo+t9vpXJ/30xEtWnQuXxO9S7Ro0bl8TfQu0aJF5/I10btEixady9dE7xItWnQuXxO9S7Ro0bl8TfQu0aJF5/I10btEixady9dE7xItWnQuXxO9S7Ro0bl87Q8/tHfGiUSW6AgAAAAASUVORK5CYII=';
const message = (slim: boolean) => messageFrom({ id: 'media-user', type: 'user', content: [
  { id: 'text', type: 'text', text: '使用 [skill:review] 看看 [photo.png]' },
  { id: 'file', type: 'file', filename: 'photo.png', mime: 'image/png', ...(slim ? { slim: true } : { url: pixel }) },
  { id: 'note', type: 'file', filename: 'notes.txt', mime: 'text/plain', url: 'file:///work/notes.txt' },
] })!;
/** Production message/attachment/preview components with exact-fill only from synthetic memory. */
function Fixture() {
  const source = signal(message(true)), active = signal(true), opened = signal(''), revision = signal(0), reads = signal(0);
  const materializer = createActivityMaterializer({ current: active, message: () => source(), changed: () => revision.set(revision() + 1),
    read: async () => { reads.set(reads() + 1); return message(false); }, apply: (full, expected) => { if (source() !== expected) return false; source.set(full); return true; } });
  const rows = computed(() => nativeBodyRows([source()]));
  return <View class="flex-1 bg-background p-4" style={{ paddingTop: 64 }}>
    <Each of={rows()}>{row => <NativeTranscriptBody row={row()} target={{ kind: 'session', id: 's', title: '', directory: '/work' }} current={active} renderCard={() => null}
      onOpenSkill={name => opened.set(name)} onOpenAttachment={file => opened.set(String(file.filename))}
      activityMaterialization={{ request: materializer.request, state: ids => { revision(); return materializer.state(ids); } }} />}</Each>
    <Text>{`reads:${reads()}`}</Text><Text>{`opened:${opened()}`}</Text><Text>{`authority:${app.runtimeScope()?.lease ?? 'initial'}`}</Text>
    <Button testID="media-hide" onPress={() => active.set(false)}><Text>Hide</Text></Button>
    <Button testID="media-renew" onPress={() => app.runtimeScope.set({ hostID: 'synthetic-media', lease: 'renewed-authority' })}><Text>Renew</Text></Button>
  </View>;
}
mount(Fixture);
