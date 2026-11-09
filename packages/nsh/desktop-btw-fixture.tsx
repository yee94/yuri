import { cleanup, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { createNativeBtwStore, type NativeBtwEntry } from './desktop-btw';

/** Engine regression of the production owner; synthetic generate port, not a replacement BTW panel. */
function Fixture() {
  const scope = { sessionId: 'fixture', directory: '/workspace' }, calls = signal(0), applies = signal(0), prompt = signal('');
  let finish: ((value: { text: string }) => void) | undefined;
  const request = signal<AbortSignal | undefined>(undefined);
  const store = createNativeBtwStore({ runtime: () => ({ transport: 'fixture', generation: 1 }), resolveSelection: () => ({ providerID: 'fixture', modelID: 'fixture' }),
    rememberSelection: () => {}, applySelection: async () => { applies.set(applies() + 1); },
    generate: async (_scope, body, options) => { request.set(options.signal); calls.set(calls() + 1); prompt.set(body.prompt); return new Promise(resolve => { finish = resolve; }); } });
  const entry = signal<NativeBtwEntry>(store.entry(scope));
  cleanup(store.observe(scope, () => entry.set(store.entry(scope)))); cleanup(store.dispose);
  return <View>
    <Text>{`calls:${calls()} applies:${applies()} turns:${entry().turns.length} pending:${entry().turns.some(turn => turn.pending)} aborted:${!!request()?.aborted}`}</Text>
    <Text>{entry().turns.map(turn => `${turn.question}:${turn.answer}`).join('|')}</Text>
    <Text>{`quoted:${prompt().includes('> quoted source')}`}</Text>
    <Button testID="quote" onPress={() => store.addQuote(scope, 'quoted source')}><Text>Quote</Text></Button>
    <Button testID="ask" onPress={() => { void store.ask(scope, 'question'); }}><Text>Ask</Text></Button>
    <Button testID="finish" onPress={() => finish?.({ text: 'synthetic answer' })}><Text>Finish</Text></Button>
    <Button testID="cancel" onPress={() => store.cancel(scope)}><Text>Cancel</Text></Button>
    <Button testID="retry" onPress={() => { void store.retry(scope); }}><Text>Retry</Text></Button>
    <Button testID="clear" onPress={() => store.clear(scope)}><Text>Clear</Text></Button>
  </View>;
}
mount(Fixture);
