import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeDesktopBrowserPane } from './desktop-browser';
import type { DesktopBrowserRequest } from './desktop-browser-core';

function Fixture() {
  const active = signal(true), result = signal(''), authorization = signal(1);
  let request: ((intent: DesktopBrowserRequest) => boolean) | null = null;
  return <View class="flex-1">
    <Button testID="fixture-preview" onPress={() => result.set(String(request?.({ kind: 'preview', path: '/work/index.html' })))}><Text>Preview</Text></Button>
    <Button testID="fixture-outside" onPress={() => result.set(String(request?.({ kind: 'preview', path: '/outside/index.html' })))}><Text>Outside</Text></Button>
    <Button testID="fixture-hide" onPress={() => active.set(!active())}><Text>Hide</Text></Button>
    <Button testID="fixture-authority" onPress={() => authorization.set(authorization() + 1)}><Text>Authority</Text></Button>
    <Text>{`browser-result:${result()}`}</Text>
    <NativeDesktopBrowserPane scope={{ host: { hostID: 'synthetic', lease: '00000000-0000-4000-8000-000000000001' }, authorityKey: `synthetic-authorization-${authorization()}`, directory: '/work', sessionID: 'synthetic' }} current={() => true} active={active()} request={value => { request = value; }} />
  </View>;
}
mount(Fixture);
