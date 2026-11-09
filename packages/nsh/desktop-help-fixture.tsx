import { host, keymap, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeDesktopHelpDialog } from './desktop-help';
import { language } from './i18n';
import type { ShortcutOverrides } from './desktop-shortcuts-core';

const open = signal(false), active = signal(true), scope = signal('A'), input = signal('Keep this composer');
const overrides = signal<ShortcutOverrides>({}), noise = signal(0);
const audit = (event: string) => host.post('desktop.help.test', { event });
const actions = {
  open_command_palette: { run() {}, supported: true, enabled: false }, open_help: { run() {} }, open_settings: { run() {} },
  open_model_selector: { run() {} }, new_chat: { run() {} }, compact_session: { run() {} }, open_agent_selector: { run() {} },
  toggle_right_sidebar: { run() {} }, toggle_terminal: { run() {}, supported: false },
};
host.on<Record<string, unknown>>('desktop.help.control', event => {
  if (event.action === 'open') open.set(true);
  else if (event.action === 'scope') scope.set(String(event.value));
  else if (event.action === 'active') active.set(event.value === true);
  else if (event.action === 'overrides') overrides.set(event.value as ShortcutOverrides);
  else if (event.action === 'language') language.set(String(event.value));
  else if (event.action === 'noise') noise.set(noise() + 1);
  else throw new Error('Unknown help fixture control');
});
language.set('en');
mount(() => {
  keymap.bind('escape', () => audit('composer-escape'), { when: 'always' });
  return <View class="flex-1">
    <Input testID="help-fixture-composer" value={input()} onChange={event => input.set(event.value)} />
    <Text>{noise()}</Text>
    <Button testID="help-fixture-open" onPress={() => open.set(true)}><Text>Open fixture help</Text></Button>
    <NativeDesktopHelpDialog open={open()} active={active()} scope={scope()} actions={actions}
      userOverrides={(() => { audit('catalog-read'); return overrides(); })()} onClose={() => { audit('closed'); open.set(false); }} />
  </View>;
});
