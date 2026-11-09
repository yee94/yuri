import { keymap, lifecycle, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createDesktopShortcutPreferences, type NativeShortcutCapture } from './desktop-shortcuts-core';
import { installNativeDesktopShortcuts } from './desktop-shortcuts';

function Fixture() {
  const settings = signal(false), composing = signal(false), scope = signal(0), capture = signal<NativeShortcutCapture | null>(null);
  const palette = signal(0), newChat = signal(0), model = signal(0), agent = signal(0), compact = signal(0), abort = signal(0), clear = signal(0);
  const metrics = signal(''), rebound = signal(false), input = signal(''), fallback = signal(0), close = signal(0), allowClose = signal(false);
  let scans = 0, writes = 0;
  const preferences = createDesktopShortcutPreferences({ getItem: async () => null, setItem: async () => { writes++; } });
  // Fallback has native admission too: it only fires if the production binding is absent.
  keymap.bind('mod+p', () => fallback.set(fallback() + 1), { when: 'notEditing' });
  const engine = installNativeDesktopShortcuts({ preferences, enabled: () => lifecycle() === 'active', settingsOpen: settings, composing, scope, capture,
    settingsAllowedActions: () => allowClose() ? ['open_settings', 'close_context_panel_tab'] : ['open_settings'],
    menuOwnedActions: () => ['new_chat'], actions: () => {
      scans++;
      return { open_command_palette: { run: () => palette.set(palette() + 1) }, new_chat: { run: () => newChat.set(newChat() + 1) },
        open_settings: { run: () => settings.set(!settings()) }, open_model_selector: { run: () => model.set(model() + 1) },
        close_context_panel_tab: { run: () => close.set(close() + 1) },
        open_agent_selector: { run: () => agent.set(agent() + 1) }, compact_session: { run: () => compact.set(compact() + 1) },
        abort_run: { run: () => abort.set(abort() + 1) }, clear_all_messages: { run: () => clear.set(clear() + 1) } };
    },
  });
  return <View class="p-4 gap-2">
    <Text>ready</Text><Text>{`palette:${palette()}`}</Text><Text>{`new:${newChat()}`}</Text><Text>{`model:${model()}`}</Text>
    <Text>{`agent:${agent()}`}</Text><Text>{`compact:${compact()}`}</Text><Text>{`abort:${abort()}`}</Text><Text>{`clear:${clear()}`}</Text>
    <Text>{`fallback:${fallback()}`}</Text>
    <Text>{`close:${close()}`}</Text>
    <Text>{metrics()}</Text><Text>{rebound() ? 'rebound' : ''}</Text>
    <Input testID="input" value={input()} onChange={event => input.set(event.value)} onCompositionChange={event => composing.set(event.composing)} />
    <Button testID="settings" onPress={() => settings.set(!settings())}><Text>Settings</Text></Button>
    <Button testID="menu-new" onPress={() => { engine.execute('new_chat'); }}><Text>Menu new</Text></Button>
    <Button testID="allow-close" onPress={() => allowClose.set(!allowClose())}><Text>Allow guarded close</Text></Button>
    <Button testID="menu-close" onPress={() => { engine.execute('close_context_panel_tab'); }}><Text>Menu close</Text></Button>
    <Button testID="capture" onPress={() => capture.set({ actionId: 'focus_input', onCapture: () => capture.set(null) })}><Text>Capture</Text></Button>
    <Button testID="ime" onPress={() => composing.set(!composing())}><Text>IME</Text></Button>
    <Button testID="scope" onPress={() => scope.set(scope() + 1)}><Text>Scope</Text></Button>
    <Button testID="dispose" onPress={engine.dispose}><Text>Dispose</Text></Button>
    <Button testID="rebind" onPress={async () => { if (await preferences.set('open_command_palette', 'alt+f8')) rebound.set(true); }}><Text>Rebind</Text></Button>
    <Button testID="metrics-reset" onPress={() => { scans = 0; writes = 0; }}><Text>Reset metrics</Text></Button>
    <Button testID="metrics" onPress={() => metrics.set(`scans:${scans} writes:${writes}`)}><Text>Metrics</Text></Button>
  </View>;
}
mount(Fixture);
