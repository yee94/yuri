import { lifecycle, mount, signal, Text, untracked, View, type InputRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeCommandSuggestions } from './composer-controls';
import { createNativeLocalCommands, type NativeLocalCommandAction, type NativeLocalCommandSnapshot } from './composer-local-commands';
import { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';

/** Synthetic action consumers; actual Input/keymap adapter, range admission and slash rows. No Host. */
export function mountLocalCommandFixture() {
  function Fixture() {
    const doc = signal(''), revision = signal(0), active = signal(true), host = signal('fixture');
    const calls = signal(0), scans = signal(0), loads = signal(0), action = signal('none'), blocked = signal('none'), late = signal(0), conflict = signal('none');
    const files = signal(1), refs = signal(false), mainPending = signal(false), target = signal<'session' | 'draft' | 'assistant'>('session');
    const failUnknown = signal(false), deferred = signal(false);
    let finish: ((value: { status: 'accepted' }) => void) | undefined, input: InputRef | undefined;
    const scope = () => ({ host: host(), draft: 'fixture', directory: '/workspace' });
    const snapshot = (): NativeLocalCommandSnapshot => ({ authority: host(), scope: scope(), target: { kind: target(), id: 'fixture', directory: '/workspace' },
      revision: revision(), text: doc(), inputMode: 'normal', active: active() && lifecycle() === 'active', ready: true,
      pending: mainPending(), unknown: false, sending: mainPending(), queueEditing: false, hasReferences: refs(), hasMessages: true, selection: null });
    const edit = (text: string) => { doc.set(text); revision.set(revision() + 1); };
    const actions: Record<string, NativeLocalCommandAction> = {};
    for (const name of ['fork', 'model', 'compact', 'btw']) actions[name] = { run: invocation => {
      action.set(`${invocation.command}:${invocation.tail}`);
      if (deferred()) return new Promise(resolve => { finish = resolve; });
      return { status: failUnknown() ? 'unknown' : 'accepted' };
    } };
    const owner = createNativeLocalCommands({ t: key => key, read: snapshot, actions,
      replaceText: (expected, value) => {
        const next = snapshot();
        if (expected.revision !== next.revision || expected.scope.host !== next.scope.host || !next.active) return false;
        edit(value); return true;
      },
      onBlocked: (_command, reason) => blocked.set(reason), onOutcome: () => late.set(late() + 1), onConflict: value => conflict.set(value.phase),
    });
    const catalog = { commands: () => { untracked(() => calls.set(calls() + 1)); return owner.catalog.commands(); }, canAutoRun: owner.catalog.canAutoRun };
    const hostCommands = new Proxy(Array.from({ length: 300 }, (_, index) => ({ name: `custom-${index}` })), {
      get(array, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) untracked(() => scans.set(scans() + 1)); return Reflect.get(array, key, receiver); },
    });
    const keyboard = createNativeReferenceKeyboard({ active: () => snapshot().active, scope, text: doc,
      insert: () => false, chooseCommand: owner.choose,
      onSubmit: () => { const result = owner.submit(); if (result.kind === 'pass') action.set('ordinary-send'); },
    });
    const seed = (text: string, cursor = text.length) => {
      keyboard.beforeChange(); edit(text); input?.focus(); keyboard.onFocus(); input?.setSelection(cursor);
      keyboard.onSelectionChange({ start: cursor, end: cursor }); keyboard.refresh();
    };
    return <View>
      <Text>{`calls:${calls()} scans:${scans()} loads:${loads()}`}</Text>
      <Text>{`action:${action()} blocked:${blocked()} outcomes:${late()} files:${files()} refs:${refs()}`}</Text>
      <Text>{`conflict:${conflict()}`}</Text>
      <Input testID="local-input" multiline value={doc()} autoFocus ref={node => { input = node; keyboard.ref(node); }}
        onChange={event => { keyboard.beforeChange(); edit(event.value); keyboard.refresh(); }} selectedRange={keyboard.selectedRange()}
        onFocus={keyboard.onFocus} onBlur={keyboard.onBlur} onCompositionChange={keyboard.onCompositionChange} onSelectionChange={keyboard.onSelectionChange}
        onSubmit={keyboard.onSubmit} submitBehavior={keyboard.submitBehavior()} />
      <Input testID="other-input" />
      <Button testID="fork" onPress={() => seed('/fo')}><Text>Fork</Text></Button>
      <Button testID="full-fork" onPress={() => seed('/fork')}><Text>Full fork</Text></Button>
      <Button testID="undo" onPress={() => seed('/und')}><Text>Undo</Text></Button>
      <Button testID="model" onPress={() => seed('/mo')}><Text>Model</Text></Button>
      <Button testID="tail" onPress={() => seed('/fo\nKEEP', 3)}><Text>Tail</Text></Button>
      <Button testID="tail-submit" onPress={() => seed('/fork KEEP')}><Text>Tail submit</Text></Button>
      <Button testID="ordinary" onPress={() => seed('ordinary')}><Text>Ordinary</Text></Button>
      <Button testID="send" onPress={() => owner.submit()}><Text>Send</Text></Button>
      <Button testID="pending" onPress={() => mainPending.set(!mainPending())}><Text>Pending</Text></Button>
      <Button testID="references" onPress={() => refs.set(!refs())}><Text>References</Text></Button>
      <Button testID="unknown" onPress={() => failUnknown.set(true)}><Text>Unknown</Text></Button>
      <Button testID="defer" onPress={() => deferred.set(true)}><Text>Defer</Text></Button>
      <Button testID="finish" onPress={() => finish?.({ status: 'accepted' })}><Text>Finish</Text></Button>
      <Button testID="host" onPress={() => host.set('other')}><Text>Host</Text></Button>
      <Button testID="assistant" onPress={() => target.set(target() === 'assistant' ? 'session' : 'assistant')}><Text>Assistant</Text></Button>
      <Button testID="ime" onPress={() => keyboard.onCompositionChange({ composing: true })}><Text>IME</Text></Button>
      <Button testID="ime-end" onPress={() => keyboard.onCompositionChange({ composing: false })}><Text>IME end</Text></Button>
      <If when={!!keyboard.commandTrigger()}><NativeCommandSuggestions scope={scope()} keyboard={keyboard} commands={hostCommands} catalog={catalog} loadCommands={async () => { loads.set(loads() + 1); }} /></If>
    </View>;
  }
  mount(Fixture);
}
