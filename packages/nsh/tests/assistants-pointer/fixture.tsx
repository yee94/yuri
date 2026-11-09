import { cleanup, mount, Scroll, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { AssistantSwipeRow } from '../../assistants-swipe';
import { readTrace, record, resetTrace } from './trace';

// Standalone native pointer fixture. No connection, runtime request or writes.
// The bounded trace contains fixed event names only, never contact content.
mount(() => {
  const binding = signal({ id: 'pointer-a', name: 'Pointer fixture A' }), generation = signal(1);
  const pinned = signal(false), disabled = signal(false), revealed = signal<string | null>(null);
  const working = signal(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  function mode(refresh: boolean) {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined; working.set(refresh); record(refresh ? 'mode-working' : 'mode-fixed');
    if (refresh) timer = setInterval(() => untracked(() => {
      record('refresh'); binding.set({ ...binding() });
    }), 2500);
  }
  cleanup(() => { if (timer !== undefined) clearInterval(timer); });
  async function menu() {
    const captured = binding(), owner = generation(); record('menu');
    const result = await AlertDialog.show({ title: captured.name, presentation: 'actionSheet', actions: [
      { id: 'edit', label: 'Edit' }, { id: 'delete', label: 'Delete', role: 'destructive' }, { id: 'cancel', label: 'Cancel', role: 'cancel' },
    ] });
    if (captured !== binding() || owner !== generation()) return;
    if (result.action === 'edit' || result.action === 'delete' || result.action === 'cancel') record(result.action);
  }
  return <Scroll class="flex-1 bg-background" contentClass="p-5 gap-5">
    <View style={{ height: 48 }}><Text testID="pointer-mode" class="text-foreground">{working() ? 'working-2500ms' : 'fixed-binding'}</Text></View>
    <View class="flex-row gap-3">
      <Button testID="pointer-reset" onPress={resetTrace}><Text>Reset trace</Text></Button>
      <Button testID="pointer-fixed" onPress={() => mode(false)}><Text>Fixed</Text></Button>
      <Button testID="pointer-working" onPress={() => mode(true)}><Text>Working</Text></Button>
    </View>
    <View class="flex-row gap-3">
      <Button testID="pointer-rebind" onPress={() => { generation.set(generation() + 1); binding.set(binding().id === 'pointer-a' ? { id: 'pointer-b', name: 'Pointer fixture B' } : { id: 'pointer-a', name: 'Pointer fixture A' }); record('rebind'); }}><Text>Rebind</Text></Button>
      <Button testID="pointer-disable" onPress={() => { disabled.set(!disabled()); record('disable'); }}><Text>Toggle disabled</Text></Button>
      <Button testID="pointer-pin" onPress={() => { pinned.set(!pinned()); record('pin'); }}><Text>Toggle pinned</Text></Button>
    </View>
    <AssistantSwipeRow binding={binding()} generation={generation()} id={binding().id} name={binding().name} pinned={pinned()} disabled={disabled()} revealed={revealed()}
      onReveal={id => { revealed.set(id); record('reveal'); }} onOpen={() => record('open')} onMenu={() => { void menu(); }} onEdit={() => record('edit')} onDelete={() => record('delete')}>
      <Text class="text-foreground">{binding().name}</Text>
    </AssistantSwipeRow>
    <View style={{ height: 320 }} class="overflow-hidden"><Text testID="pointer-trace" class="text-xs text-foreground">{readTrace().join(' → ')}</Text></View>
    <View style={{ height: 900 }}><Text testID="pointer-scroll-end" class="text-foreground">Scroll target</Text></View>
  </Scroll>;
});
