import { effect, lifecycle, mount, platform, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { getEffectiveShortcutCombo } from '../ui/src/lib/shortcuts-core';
import { createDesktopShortcutPreferences, nativeShortcutKeystroke, type NativeShortcutActions, type NativeShortcutBinding, type NativeShortcutCapture, type NativeShortcutIntent } from './desktop-shortcuts-core';
import { installNativeDesktopShortcuts } from './desktop-shortcuts';

function Fixture() {
  const active = signal(true), composing = signal(false), settings = signal(false), overlay = signal(false), scope = signal(0), menuOwned = signal(false);
  const capture = signal<NativeShortcutCapture | null>(null), draft = signal(''), result = signal(''), events = signal<Array<{ id: string; intent?: NativeShortcutIntent }>>([]), metrics = signal('');
  const abortPrimed = signal(false), leaderPending = signal(false), captureValue = signal('');
  let captured: NativeShortcutBinding | undefined, releasePreferences: (() => void) | undefined;
  let scans = 0, writes = 0, plans = 0;
  const preferences = createDesktopShortcutPreferences({ getItem: () => new Promise(resolve => { releasePreferences = () => resolve(null); }), setItem: async () => { writes++; } });
  const action = (id: string) => ({ when: 'always' as const, run: (intent?: NativeShortcutIntent) => events.set([...events(), { id, intent }]) });
  const actions: NativeShortcutActions = {
    open_command_palette: action('palette'), open_settings: action('settings'), cycle_agent: action('agent'),
    abort_run: action('abort'), open_model_selector: action('model'), next_terminal_tab: action('terminal'),
  };
  const engine = installNativeDesktopShortcuts({ preferences, actions: () => { scans++; return actions; },
    enabled: () => active() && lifecycle() === 'active', composing, settingsOpen: settings, blockingOverlay: overlay, capture, scope,
    menuOwnedKeystrokes: () => menuOwned() ? [nativeShortcutKeystroke(getEffectiveShortcutCombo('open_command_palette', engine.userOverrides()), platform.os === 'macos')!] : [],
    onAbortPrimed: value => abortPrimed.set(value), onLeaderPending: value => leaderPending.set(value),
  });
  let lastPlan = engine.bindings();
  effect(() => { const next = engine.bindings(); if (next !== lastPlan) { plans++; lastPlan = next; } });
  const find = (id: string, direction?: -1 | 1) => engine.bindings().find(binding => binding.actionId === id && (direction === undefined || binding.direction === direction));
  const dispatch = (id: string, direction?: -1 | 1) => { const binding = find(id, direction); result.set(String(!!binding && engine.dispatchBinding(binding))); };
  return <View class="p-4 gap-2">
    <Text>{engine.ready() ? 'ready' : 'not-ready'}</Text>
    <Text>{`bindings:${JSON.stringify(engine.bindings())}`}</Text><Text>{`events:${JSON.stringify(events())}`}</Text>
    <Text>{`accepted:${result()}`}</Text><Text>{`abort-primed:${abortPrimed()} leader-pending:${leaderPending()}`}</Text>
    <Text>{`capture:${captureValue()}`}</Text><Text>{metrics()}</Text>
    <Input testID="routing-input" value={draft()} onChange={event => draft.set(event.value)} onCompositionChange={event => composing.set(event.composing)} />
    <Button testID="release-preferences" onPress={() => releasePreferences?.()}><Text>Load preferences</Text></Button>
    <Button testID="capture-palette" onPress={() => { captured = find('open_command_palette'); }}><Text>Keep palette binding</Text></Button>
    <Button testID="dispatch-old" onPress={() => result.set(String(!!captured && engine.dispatchBinding(captured)))}><Text>Dispatch kept binding</Text></Button>
    <Button testID="dispatch-copy" onPress={() => result.set(String(!!captured && engine.dispatchBinding({ ...captured })))}><Text>Untrusted copy</Text></Button>
    <Button testID="dispatch-forged" onPress={() => result.set(String(!!captured && engine.dispatchBinding({ ...captured, actionId: 'abort_run' })))}><Text>Untrusted action</Text></Button>
    <Button testID="dispatch-palette" onPress={() => dispatch('open_command_palette')}><Text>Route palette</Text></Button>
    <Button testID="dispatch-back" onPress={() => dispatch('cycle_agent', -1)}><Text>Route reverse Agent</Text></Button>
    <Button testID="dispatch-forward" onPress={() => dispatch('cycle_agent', 1)}><Text>Route forward Agent</Text></Button>
    <Button testID="dispatch-abort" onPress={() => dispatch('abort_run')}><Text>Route abort</Text></Button>
    <Button testID="dispatch-leader" onPress={() => dispatch('leader_key')}><Text>Route leader</Text></Button>
    <Button testID="menu-palette" onPress={() => result.set(String(engine.execute('open_command_palette')))}><Text>Menu palette</Text></Button>
    <Button testID="rebind" onPress={() => { void preferences.set('open_command_palette', 'alt+f8'); }}><Text>Change palette key</Text></Button>
    <Button testID="scope" onPress={() => scope.set(scope() + 1)}><Text>Change scope</Text></Button>
    <Button testID="active" onPress={() => active.set(!active())}><Text>Toggle active</Text></Button>
    <Button testID="ime" onPress={() => composing.set(!composing())}><Text>Toggle IME</Text></Button>
    <Button testID="settings" onPress={() => settings.set(!settings())}><Text>Toggle settings</Text></Button>
    <Button testID="overlay" onPress={() => overlay.set(!overlay())}><Text>Toggle overlay</Text></Button>
    <Button testID="menu-owned" onPress={() => menuOwned.set(!menuOwned())}><Text>Toggle menu accelerator</Text></Button>
    <Button testID="capture" onPress={() => { settings.set(true); capture.set({ actionId: 'focus_input', onCapture: value => { captureValue.set(value ?? 'cancelled'); capture.set(null); } }); }}><Text>Capture a key</Text></Button>
    <Button testID="reset-metrics" onPress={() => { scans = writes = plans = 0; }}><Text>Reset metrics</Text></Button>
    <Button testID="metrics" onPress={() => metrics.set(`plans:${plans} scans:${scans} writes:${writes}`)}><Text>Inspect metrics</Text></Button>
    <Button testID="dispose" onPress={() => engine.dispose()}><Text>Dispose root</Text></Button>
  </View>;
}
mount(Fixture);
