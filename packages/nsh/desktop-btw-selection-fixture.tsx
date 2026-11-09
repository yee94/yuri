import { cleanup, computed, host, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { createNativeBtwStore, type NativeBtwSelection } from './desktop-btw';
import { NativeDesktopBtwPanel } from './desktop-btw-panel';
import type { NativeDesktopBtwHandle } from './desktop-btw-panel-core';
import { NativeDesktopBtwSelection } from './desktop-btw-selection';
import { record, text } from './model';

function Fixture() {
  const current = signal(true), visible = signal(true), scope = signal('first');
  const draft = signal('main draft'), counters = signal('');
  const selection = signal<NativeBtwSelection | null>(record(host.params).empty === true ? null : { providerID: 'fixture', modelID: 'gpt-4o-mini', variant: 'high', agent: 'do-not-render-agent' });
  const projection = signal<{ scope: string; providerID: string; modelID: string; label: string } | null>(null);
  let labelReads = 0, handle: NativeDesktopBtwHandle | undefined;
  const label = computed(() => {
    labelReads++;
    const value = projection();
    return value && value.scope === scope() ? value : undefined;
  });
  const event = (name: string, value?: unknown) => { void host.call('btw.fixture', { name, value }); };
  const store = createNativeBtwStore({ runtime: () => ({ transport: 'fixture', generation: 1 }), resolveSelection: selection,
    rememberSelection: (_scope, value) => event('selected', value),
    applySelection: async (_scope, value) => event('applied', value),
    generate: async () => { event('generate'); return new Promise(() => {}); } });
  cleanup(store.dispose);
  cleanup(host.on('btw.control', input => {
    const value = record(input);
    switch (value.action) {
      case 'stats': counters.set(String(labelReads)); event('snapshot', store.selection({ sessionId: scope(), directory: '/work tree' })); break;
      case 'current': current.set(value.value === true); break;
      case 'visible': visible.set(value.value === true); break;
      case 'scope': scope.set(text(value.value)); break;
      case 'selection': {
        const next = record(value.value);
        selection.set(value.value === null ? null : { providerID: text(next.providerID), modelID: text(next.modelID), ...(typeof next.agent === 'string' ? { agent: next.agent } : {}), ...(typeof next.variant === 'string' || next.variant === null ? { variant: next.variant } : {}) }); break;
      }
      case 'label': {
        const next = record(value.value);
        projection.set({ scope: text(next.scope), providerID: text(next.providerID), modelID: text(next.modelID), label: text(next.label) }); break;
      }
      case 'pending': if (value.value === true) handle?.ask('synthetic pending'); else handle?.cancel(); break;
    }
  }));
  return <View class="flex-1">
    <Text testID="selection-counters">{counters()}</Text>
    <Input testID="main-editor" value={draft()} onChange={event => draft.set(event.value)} />
    <NativeDesktopBtwPanel store={store} scope={{ sessionId: scope(), directory: '/work tree' }} authority={scope()} current={current} active visible={visible()} interactive onClose={() => {}}
      onHandle={value => { handle = value; return () => { if (handle === value) handle = undefined; }; }}
      renderSelection={slot => <NativeDesktopBtwSelection slot={slot} label={label()} current={current} />} />
  </View>;
}
mount(Fixture);
