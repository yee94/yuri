import { mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { ChatHeaderActions, NativeChatHeader } from './chat-header';
import { language } from './i18n';
import { request } from './runtime';
import { headerQuotaReset } from './chat-header-quota';
import { loadConnections } from './state';

export default function HeaderTestApp() {
  const ready = signal(false);
  void loadConnections().then(() => ready.set(true));
  return <If when={ready()}><HeaderContent /></If>;
}
function HeaderContent() {
  language.set('en');
  const back = signal(false), options = signal(''), draft = signal(''), count = signal(-1), native = signal(false), anchorError = signal('');
  return <View class="flex-1 bg-background p-4 gap-4">
    <If when={native()} else={<NativeChatHeader target={{ kind: 'session', id: 'ses_header', title: 'Native conversation', directory: '/workspace/header' }} active busy={false} current={() => true} onBack={() => back.set(true)} onOptions={option => options.set(option)} />}>
      <ChatHeaderActions native target={{ kind: 'session', id: 'ses_header', title: 'Native conversation', directory: '/workspace/header' }} active busy={false} current={() => true} onOptions={option => options.set(option)} onError={() => anchorError.set('Anchor unavailable')} />
    </If>
    <Button testID="native-header" onPress={() => native.set(true)}><Text>Use system slot</Text></Button>
    <Button testID="fail-anchor" onPress={() => { void request('/fixture/fail-anchor'); }}><Text>Fail anchor</Text></Button>
    <Text>{anchorError()}</Text>
    <Input testID="unrelated-input" value={draft()} onChange={event => draft.set(event.value)} />
    <Button testID="request-count" onPress={() => { void request('/fixture/request-count').then(value => count.set(Number(value))); }}><Text>Count requests</Text></Button>
    <Text>{`Calls ${count()}`}</Text>
    <Text>{headerQuotaReset({ usedPercent: null, remainingPercent: null, resetAt: new Date(2030, 0, 1, 13, 5).getTime(), resetAfterSeconds: null, resetAtFormatted: 'Host fallback', resetAfterFormatted: null, windowSeconds: null }, '24h', new Date(2030, 0, 1, 12).getTime())}</Text>
    <Text>{back() ? 'Back pressed' : ''}</Text><Text>{options() ? `Options ${options()}` : ''}</Text>
  </View>;
}
mount(HeaderTestApp);
