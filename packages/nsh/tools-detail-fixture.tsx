import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeToolRow } from './transcript-tools';
import { language } from './i18n';
import type { Row } from './model';

language.set('en-US');
function Fixture() {
  const tool = signal<Row>({ id: 'literal-shell', name: 'shell', time: { ran: 1000, completed: 12400 }, state: { status: 'completed', input: { command: 'printf **literal**', timeout: 5000 }, content: [{ type: 'text', text: '**literal output**\n' }] } });
  const current = signal(true);
  return <View>
    <NativeToolRow tool={tool()} target={{ kind: 'session', id: 'fixture', title: 'Fixture', directory: '/fixture' }} current={current} />
    <Button testID="replace-tool" onPress={() => tool.set({ id: 'literal-shell', tool: 'shell', state: { status: 'error', input: { command: 'printf replacement' }, error: 'fixture failure' } })}><Text>Replace fixture tool</Text></Button>
    <Button testID="expire-page" onPress={() => current.set(false)}><Text>Expire fixture page</Text></Button>
  </View>;
}
mount(Fixture);
