import { cleanup, effect, lifecycle, mount, signal, Text, untracked, View, type InputRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';
import { mixedReferenceRows } from './composer-references';
import { createNativeDesktopComposerShortcutOwner, type NativeDesktopComposerShortcutOwner, type NativeDesktopComposerShortcutRegistration } from './desktop-composer-actions';
import { NativeNewSessionPage } from './new-session-page';
import { NativeComposerSelection } from './chat-composer-selection';
import { language } from './i18n';
import { loadConnections } from './state';
import { request } from './runtime';
import { installNativeDesktopShortcuts } from './desktop-shortcuts';

function KeyboardFixture() {
  const draft = signal(''), sends = signal(0), active = signal(true), composing = signal(false);
  const scope = { host: 'synthetic', draft: 'desktop-keyboard-actions', directory: '/fixture' };
  let input: InputRef | undefined;
  const keyboard = createNativeReferenceKeyboard({ active: () => active() && lifecycle() === 'active', scope: () => scope, text: draft,
    insert: (candidate, start, end) => { draft.set(draft().slice(0, start) + '@' + candidate.value + ' ' + draft().slice(end)); return true; }, onSubmit: () => sends.set(sends() + 1),
  });
  const shortcuts = createNativeDesktopComposerShortcutOwner({ current: () => active() && lifecycle() === 'active', composing, overlayOpen: () => false, actions: {
    focus_input: { run: () => input?.focus() }, submit_message: { run: keyboard.onSubmit },
  } });
  cleanup(shortcuts.retire);
  effect(() => { const trigger = keyboard.trigger(); if (trigger) untracked(() => keyboard.core.rows({ scope, query: trigger.query }, mixedReferenceRows([{ kind: 'file', value: 'src/file.ts', label: 'src/file.ts', scope }], trigger.query))); });
  return <View class="gap-2">
    <Input testID="keyboard-input" multiline value={draft()} ref={node => { input = node; keyboard.ref(node); }} onFocus={keyboard.onFocus} onBlur={keyboard.onBlur} selectedRange={keyboard.selectedRange()} onSelectionChange={keyboard.onSelectionChange} onCompositionChange={event => { composing.set(event.composing); keyboard.onCompositionChange(event); }} submitBehavior={keyboard.submitBehavior()} onSubmit={keyboard.onSubmit} onChange={event => { keyboard.beforeChange(); draft.set(event.value); keyboard.refresh(); }} />
    <Text>sends:{sends()}</Text>
    <Button testID="keyboard-submit" onPress={() => shortcuts.owner.actions.submit_message!.run({ source: 'menu' })}><Text>Submit action</Text></Button>
    <Button testID="keyboard-ime-start" onPress={() => { composing.set(true); keyboard.onCompositionChange({ composing: true }); }}><Text>IME</Text></Button>
    <Button testID="keyboard-ime-end" onPress={() => { composing.set(false); keyboard.onCompositionChange({ composing: false }); }}><Text>IME end</Text></Button>
    <Button testID="keyboard-hide" onPress={() => active.set(false)}><Text>Hide</Text></Button>
  </View>;
}

function Fixture() {
  language.set('en');
  const ready = signal(false), mode = signal<'none' | 'draft' | 'chat' | 'assistant' | 'keyboard'>('none'), active = signal(true);
  const owner = signal<NativeDesktopComposerShortcutOwner | null>(null), registers = signal(0), retires = signal(0), selected = signal(''), audit = signal(''), handed = signal(false);
  const selectionOpen = signal<'model' | 'agent' | null>(null), draft = signal('');
  let retired: NativeDesktopComposerShortcutOwner | null = null;
  const publish = (event: NativeDesktopComposerShortcutRegistration) => {
    if (event.type === 'register') { owner.set(event.owner); registers.set(registers() + 1); }
    else { retired = event.owner; retires.set(retires() + 1); if (owner() === event.owner) owner.set(null); }
  };
  const run = (id: string, direction?: -1 | 1) => { void owner()?.actions[id]?.run({ source: 'menu', direction }); };
  // The fixture is a desktop root too: dispatch physical shortcuts through the
  // same single registry as production, never by clicking outside autocomplete.
  installNativeDesktopShortcuts({ actions: () => owner()?.actions ?? {}, enabled: () => ready() && active() && lifecycle() === 'active',
    settingsOpen: () => false, userOverrides: () => ({}), composing: () => owner()?.composing() ?? false,
    blockingOverlay: () => owner()?.overlayOpen() ?? false, scope: owner,
  });
  void loadConnections().then(() => ready.set(true));
  return <View class="flex-1 bg-background">
    <View class="flex-row flex-wrap gap-2">
      <Each of={['none', 'draft', 'chat', 'assistant', 'keyboard'] as const}>{value => <Button testID={`mode-${value()}`} onPress={() => { active.set(true); mode.set(value()); }}><Text>{value()}</Text></Button>}</Each>
      <Each of={['focus_input', 'submit_message', 'clear_input', 'open_model_selector', 'open_agent_selector', 'cycle_agent', 'cycle_thinking_variant']}>{id => <Button testID={`action-${id()}`} onPress={() => run(id())}><Text>{id()}</Text></Button>}</Each>
      <Button testID="action-cycle-back" onPress={() => run('cycle_agent', -1)}><Text>Previous Agent</Text></Button>
      <Button testID="action-hide" onPress={() => active.set(false)}><Text>Hide</Text></Button>
      <Button testID="action-show" onPress={() => active.set(true)}><Text>Show</Text></Button>
      <Button testID="action-close" onPress={() => selectionOpen.set(null)}><Text>Close selection</Text></Button>
      <Button testID="action-retired" onPress={() => { void retired?.actions.cycle_agent?.run({ source: 'menu' }); }}><Text>Late old owner</Text></Button>
      <Button testID="action-host" onPress={() => { void loadConnections({ forceReconnect: true }); }}><Text>Retire Host</Text></Button>
      <Button testID="action-release" onPress={() => { void request('/__composer/release'); }}><Text>Release write</Text></Button>
      <Button testID="action-defer" onPress={() => { void request('/__composer/defer'); }}><Text>Defer write</Text></Button>
      <Button testID="action-audit" onPress={() => { void request('/__composer/stats').then(value => audit.set(JSON.stringify(value))); }}><Text>Inspect Host</Text></Button>
    </View>
    <Text testID="registration-audit">registrations:{registers()} retires:{retires()}</Text>
    <Text testID="selection-audit">{selected()}</Text><Text testID="host-audit">{audit()}</Text>
    <If when={ready()}>
      <If when={mode() === 'none'}><NativeNewSessionPage directory="/fixture/project" active={active()} onOpenChat={() => handed.set(true)} /></If>
      <If when={mode() === 'draft'}><NativeNewSessionPage directory="/fixture/project" active={active()} onOpenChat={() => handed.set(true)} onDesktopShortcuts={publish} onSelection={(_directory, model, agent) => selected.set(JSON.stringify({ model, agent }))} /></If>
      <If when={mode() === 'chat'}><Input testID="selection-input" value={draft()} onChange={event => draft.set(event.value)} /><NativeComposerSelection target={{ kind: 'session', id: 'selection-session', title: 'Selection', directory: '/fixture/project' }} active={active()} open={selectionOpen()} onOpenChange={value => selectionOpen.set(value)} onAssistantEdit={() => {}} onDesktopShortcuts={publish} onSelection={value => selected.set(JSON.stringify(value))} /></If>
      <If when={mode() === 'assistant'}><NativeComposerSelection target={{ kind: 'assistant', id: 'selection-bot', title: 'Bot', directory: '/fixture/project' }} active={active()} open={selectionOpen()} onOpenChange={value => selectionOpen.set(value)} onAssistantEdit={() => selected.set('assistant edit requested')} onDesktopShortcuts={publish} onSelection={value => selected.set(JSON.stringify(value))} /></If>
      <If when={mode() === 'keyboard'}><KeyboardFixture /></If>
    </If>
    <If when={handed()}><Text testID="handoff-complete">handoff complete</Text></If>
  </View>;
}
mount(Fixture);
