import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { createNativeSpeech, NativeSpeechSettingsError } from './speech';
import { NativeMessageActions } from './transcript-actions';
import { language } from './i18n';
import type { Message } from './model';

export default function SpeechTestApp() {
  language.set('en');
  const active = signal(true);
  const speech = createNativeSpeech({ current: () => active() });
  const message = (): Message => ({ id: 'neutral-message', role: 'assistant', text: '**Neutral response.**', error: '', parts: [] } as unknown as Message);
  const history = { props: () => ({ target: { kind: 'assistant', id: 'neutral' }, scope: { current: () => true, busy: () => false }, onError: () => {} }) } as unknown as Parameters<typeof NativeMessageActions>[0]['history'];
  return <View><NativeSpeechSettingsError speech={speech} /><NativeMessageActions history={history} message={message} speech={speech} />
    <Text>{speech.state().status}</Text>
    <Button testID="speech-hide" onPress={() => active.set(false)}><Text>Hide page</Text></Button>
  </View>;
}
mount(SpeechTestApp);
