import { cleanup, effect, host, mount, signal, Text, untracked, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createDesktopTerminalBinding } from './desktop-terminal-core';
import { createDesktopTerminalSignals } from './desktop-terminal-signals';
import { createNativeDesktopTerminalShortcutOwner } from './desktop-terminal-actions';
import { nativeShortcutBindings } from './desktop-shortcuts-core';
import { createNativeTerminalWorkspace } from './terminal';

// Headless carrier for the production changed adapter, controller and shortcut
// getters. Native renderer events are synthetic, not evidence of HWND/WebKit.
function Fixture() {
  const scope = { hostID: 'synthetic', lease: 'synthetic-lease' };
  const interaction = createDesktopTerminalSignals(), active = signal(true), audit = signal(''), draft = signal(''), previews = signal('');
  let plans = 0, receipts = 0, renders = 0, publications = 0;
  const event = (value: Record<string, unknown>) => binding.event({ owner: binding.owner, generation: binding.state().generation, expectedHost: scope, ...value });
  const binding = createDesktopTerminalBinding({ scope, current: () => true, call: (name, body) => host.call(name, body),
    changed: value => { publications++; interaction.changed(value); },
    createWorkspace: () => createNativeTerminalWorkspace(scope, async (authority, directory, url, mode) => { previews.set(JSON.stringify({ authority, directory, url, mode })); }),
    command: (name, body) => {
      if (name === 'inputResult') receipts++;
      if (name === 'render' && Array.isArray(body.chunks) && body.chunks.length) {
        renders++; const chunks = body.chunks as { id: number }[];
        void Promise.resolve().then(() => event({ type: 'ack', key: body.key, serial: body.serial, cursor: chunks.at(-1)!.id }));
      }
    },
  });
  const shortcuts = createNativeDesktopTerminalShortcutOwner({ current: active, ready: interaction.ready, focused: interaction.focused, composing: interaction.composing,
    create() {}, focus() {}, expand() {}, cycle() {},
  });
  effect(() => { shortcuts.owner.current(); shortcuts.owner.focused(); shortcuts.owner.composing(); nativeShortcutBindings({ actions: shortcuts.owner.actions, apple: false, settingsOpen: false }); plans++; });
  effect(() => { const value = active(); untracked(() => binding.update({ active: value, scope, directory: value ? '/synthetic' : '' })); });
  effect(() => { interaction.state(); const value = binding.workspace()?.snapshot(); if (value) untracked(() => binding.present(value)); });
  const report = () => audit.set(JSON.stringify({ plans, receipts, renders, publications, phase: binding.state().phase, error: binding.state().error, preview: binding.workspace()?.snapshot().tabs[0]?.previewUrl, ready: interaction.ready(), focused: interaction.focused(), composing: interaction.composing() }));
  cleanup(() => { shortcuts.retire(); binding.dispose(); });
  return <View>
    <Input testID="terminal-signal-type" value={draft()} onChange={change => { draft.set(change.value); void event({ type: 'input', key: binding.workspace()?.snapshot().activeId, data: change.value, receipt: receipts + 1 }); }} />
    <Button testID="terminal-signal-boot" onPress={async () => { await event({ type: 'ready', version: 1 }); await event({ type: 'resize', key: binding.workspace()?.snapshot().activeId, cols: 90, rows: 20 }); await event({ type: 'focus', focused: true }); }}><Text>boot</Text></Button>
    <Button testID="terminal-signal-output" onPress={() => host.call('fixture.output', {})}><Text>output</Text></Button>
    <Button testID="terminal-signal-ime" onPress={() => event({ type: 'composition', composing: !interaction.composing() })}><Text>ime</Text></Button>
    <Button testID="terminal-signal-hide" onPress={() => active.set(!active())}><Text>visibility</Text></Button>
    <Button testID="terminal-signal-link" onPress={() => event({ type: 'openPreview', key: binding.workspace()?.snapshot().activeId, url: 'http://localhost:3000/', mode: 'preview' })}><Text>link</Text></Button>
    <Button testID="terminal-signal-preview" onPress={() => { const id = binding.workspace()?.snapshot().activeId; if (id) return binding.workspace()?.controller.openPreview(id); }}><Text>discovered preview</Text></Button>
    <Button testID="terminal-signal-audit" onPress={report}><Text>audit</Text></Button>
    <Text>{`signal-audit:${audit()}`}</Text><Text>{`signal-preview:${previews()}`}</Text>
  </View>;
}
mount(Fixture);
