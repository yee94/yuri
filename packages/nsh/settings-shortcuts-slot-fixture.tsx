import { cleanup, lifecycle, mount, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { SETTINGS_ENTRIES, SettingsHome, type SettingsRoute } from './settings';
import { NativeDesktopSettingsWindow } from './desktop-settings';
import { NativeDesktopSettingsContent, desktopSettingsIntegratedPages, type DesktopSettingsContentNavigationState } from './desktop-settings-content';
import { DesktopShortcutsSettings } from './desktop-shortcuts-settings';
import { createDesktopShortcutPreferences, type NativeShortcutActions, type NativeShortcutCapture } from './desktop-shortcuts-core';
import { installNativeDesktopShortcuts } from './desktop-shortcuts';

function Fixture() {
  language.set('en');
  const open = signal(false), route = signal<SettingsRoute>({ page: 'shortcuts' }), state = signal<DesktopSettingsContentNavigationState | null>(null);
  const capture = signal<NativeShortcutCapture | null>(null), stored = signal('{}'), hold = signal(false), mounts = signal(0);
  const executions = signal(0);
  let release: (() => void) | undefined;
  const preferences = createDesktopShortcutPreferences({ getItem: async () => stored(), setItem: async (_key, value) => {
    if (hold()) { hold.set(false); await new Promise<void>(done => { release = done; }); }
    stored.set(value);
  } });
  cleanup(preferences.dispose);
  const actions = (): NativeShortcutActions => ({ open_command_palette: { run() {} }, focus_input: { run() {} },
    ...Object.fromEntries(['previous_session', 'next_session', ...Array.from({ length: 9 }, (_, index) => `switch_tab_${index + 1}`), 'new_chat'].map(id => [id, { enabled: !open(), run: () => executions.set(executions() + 1) }])),
    open_model_selector: { supported: false, run: () => executions.set(executions() + 1) },
  });
  installNativeDesktopShortcuts({ actions, preferences, capture, enabled: () => lifecycle() === 'active', settingsOpen: open });
  const callbacks = { onOpen: (next: SettingsRoute) => route.set(next), onBack: () => open.set(false), onConnect() {} };
  return <View class="flex-1 bg-background">
    <Text>{`registry-shortcuts=${SETTINGS_ENTRIES.some(entry => entry.page === 'shortcuts')}`}</Text>
    <Text>{`slot-mounts=${mounts()};stored=${stored()}`}</Text>
    <Text>{`executions=${executions()}`}</Text>
    <Text>{`protection=${state()?.status};pending=${state()?.pending};dirty=${state()?.dirty};picker=${state()?.nestedPickerOpen}`}</Text>
    <Button testID="shortcut-window-open" onPress={() => open.set(true)}><Text>Open desktop Settings</Text></Button>
    <Button testID="shortcut-write-hold" onPress={() => hold.set(true)}><Text>Hold storage ACK</Text></Button>
    <Button testID="shortcut-write-release" onPress={() => { const done = release; release = undefined; done?.(); }}><Text>Release storage ACK</Text></Button>
    <If when={!open()}><SettingsHome {...callbacks} /></If>
    <NativeDesktopSettingsWindow open={open()} route={route()} visiblePages={[...desktopSettingsIntegratedPages, 'shortcuts']}
      pending={state()?.pending === true} dirty={state()?.dirty !== false || state()?.status !== 'ready'} nestedPickerOpen={state()?.nestedPickerOpen === true}
      confirmDiscard={() => state()?.requestLeave() ?? false} onClose={() => open.set(false)} onNavigate={callbacks.onOpen}
      renderPage={context => <NativeDesktopSettingsContent route={context.route} active={context.active} callbacks={callbacks}
        onNavigationState={value => { if (value.status !== 'retired' || state()?.owner === value.owner) state.set(value); }}
        shortcuts={slot => { untracked(() => mounts.set(mounts() + 1)); return <DesktopShortcutsSettings preferences={preferences} actions={actions} capture={capture} onCaptureChange={value => capture.set(value)} active={slot.active} />; }} />}
    />
  </View>;
}
mount(Fixture);
