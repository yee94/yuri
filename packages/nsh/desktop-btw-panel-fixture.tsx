import { cleanup, host, mount, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeDesktopBtwPanel, type NativeBtwSpeech } from './desktop-btw-panel';
import { createNativeBtwStore, type NativeBtwRuntime, type NativeBtwSelection } from './desktop-btw';
import type { NativeDesktopBtwHandle } from './desktop-btw-panel-core';
import { record, text } from './model';

function Fixture() {
  const visible = signal(true), active = signal(true), interactive = signal(true), current = signal(true), foot = signal<'panel' | 'page'>('panel');
  const authority = signal('first'), scope = signal({ sessionId: 'session', directory: '/workspace' }), runtime = signal<NativeBtwRuntime>({ transport: 'first', generation: 1 });
  const speech = signal('idle' as ReturnType<NativeBtwSpeech['state']>), selection = signal<NativeBtwSelection>({ providerID: 'openai', modelID: 'first', agent: 'first-agent', variant: 'low' });
  const selected = signal(0), unavailable = record(host.params).unavailable === true, customSlot = record(host.params).customSlot === true;
  let handle: NativeDesktopBtwHandle | null = null, retained: NativeDesktopBtwHandle | null = null;
  const replies: Array<{ resolve: (value: { text: string }) => void; reject: (cause: Error) => void }> = [];
  const event = (name: string, value?: unknown) => { void host.call('btw.fixture', { name, value }); };
  const store = createNativeBtwStore({ runtime, resolveSelection: () => selection(), rememberSelection: (_scope, value) => { selection.set(value); },
    applySelection: async (_scope, value) => { event('apply', value); },
    generate: unavailable ? undefined : async (_scope, body, request) => {
      event('generate', body); request.signal.addEventListener('abort', () => event('aborted'), { once: true });
      return new Promise((resolve, reject) => replies.push({ resolve, reject }));
    }, now: () => 1700000000000, elapsed: () => 100 });
  cleanup(store.dispose);
  cleanup(host.on('btw.control', value => {
    const body = record(value);
    switch (body.action) {
      case 'visible': visible.set(body.value === true); break;
      case 'active': active.set(body.value === true); break;
      case 'interactive': interactive.set(body.value === true); break;
      case 'current': current.set(body.value === true); break;
      case 'foot': foot.set(body.value === 'page' ? 'page' : 'panel'); break;
      case 'quote': event('quote', handle?.addQuote(text(body.value))); break;
      case 'ask': event('ask', handle?.ask(text(body.value))); break;
      case 'retry': event('retry', handle?.retry()); break;
      case 'cancel': event('cancel', handle?.cancel()); break;
      case 'close': retained = handle; event('close', handle?.close()); break;
      case 'stale-close': event('stale-close', retained?.close()); break;
      case 'save-handle': retained = handle; break;
      case 'answer': replies[Number(body.index) || 0]?.resolve({ text: text(body.value) }); break;
      case 'error': replies[Number(body.index) || 0]?.reject(new Error('synthetic failure')); break;
      case 'scope': scope.set({ sessionId: text(body.value), directory: '/workspace' }); authority.set(text(body.value)); break;
      case 'host': runtime.set({ transport: 'second', generation: 2 }); authority.set('second'); break;
      case 'selection': handle?.setSelection({ providerID: 'openai', modelID: 'replacement', agent: 'replacement-agent' }); break;
    }
  }));
  return <View style={{ width: '100%', height: '100%' }}>
    <Text testID="slot-renders">{`selection-renders:${selected()}`}</Text>
    <NativeDesktopBtwPanel store={store} scope={scope()} authority={authority()} current={current} visible={visible()} active={active()} interactive={interactive()} foot={foot()}
      onHandle={value => { handle = value; event('handle', true); return () => { if (handle === value) handle = null; }; }} onClose={value => { visible.set(false); event('closed-scope', value.sessionId); }}
      modelLabel={value => { untracked(() => selected.set(selected() + 1)); return value.modelID; }}
      renderSelection={customSlot ? slot => {
        event('slot-render');
        return <Button testID="btw-selection-slot" disabled={!slot.current()} onPress={() => slot.setSelection({ providerID: 'openai', modelID: 'slot-model', agent: 'slot-agent' })}><Text>{slot.selection()?.modelID}</Text></Button>;
      } : undefined}
      onChooseModel={slot => { slot.setSelection({ providerID: 'openai', modelID: 'chosen-model', agent: slot.selection()?.agent }); }}
      onChooseAgent={slot => { const value = slot.selection(); if (value) slot.setSelection({ ...value, agent: 'chosen-agent' }); }}
      copy={async value => { event('copied', value); return value !== 'copy failure'; }}
      speech={{ state: () => speech(), speak: async (_id, value) => { speech.set('playing'); event('spoken', value); }, stop: async () => { speech.set('idle'); event('speech-stopped'); } }} />
    <Button testID="noise" onPress={() => {}}><Text>Noise</Text></Button>
  </View>;
}
mount(Fixture);
