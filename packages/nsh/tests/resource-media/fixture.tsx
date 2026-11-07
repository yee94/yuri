import { cleanup, host, mount, safeArea, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { ResourcePreview } from '../../resources';
import { native } from '../../runtime';
import { app } from '../../state';
import { language } from '../../i18n';

// These neutral labels/counters are test data, not shipping application copy.
language.set('en');
function ResourceMediaFixture() {
  const uikit = host.params.resourceMediaUIKitFixture === true;
  const path = signal(''), active = signal(true), local = signal(''), nativeSnapshot = signal(''), sequenceSnapshot = signal(''), fixtureError = signal('');
  const scope = signal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reads = 0, successes = 0, failures = 0, previewCalls = 0, cancelCalls = 0, closeCalls = 0, releaseCalls = 0;
  let lease = '', lastPreviewLease = '', kind = '', preview = '';
  const released = new Set<string>();
  const publish = () => local.set(JSON.stringify({ reads, successes, failures, previewCalls, cancelCalls, closeCalls, releaseCalls,
    lease, lastPreviewLease, kind, preview, currentLeaseReleased: released.has(lease), scope: scope() }));
  // Transparent call observer only: forwards identical arguments and results to
  // the installed production Swift handlers. It never creates a preview result.
  const forward = host.call.bind(host);
  host.call = async function <T>(name: string, data?: unknown, options?: { timeout?: number }): Promise<T> {
    const args = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    untracked(() => {
      if (name === 'resources.read') reads++;
      if (name === 'resources.cancel') cancelCalls++;
      if (name === 'resources.close') closeCalls++;
      if (name === 'resources.release') { releaseCalls++; if (typeof args.lease === 'string') released.add(args.lease); }
      if (name === 'resources.present' && args.action === 'preview') { previewCalls++; lastPreviewLease = String(args.lease); }
      publish();
    });
    try {
      const result = await forward<T>(name, data, options);
      if (name === 'resources.read' && result && typeof result === 'object') {
        const value = result as Record<string, unknown>;
        untracked(() => { successes++; lease = String(value.lease); kind = String(value.kind); preview = String(value.preview ?? 'missing'); publish(); });
      }
      return result;
    } catch (error) {
      if (name === 'resources.read') untracked(() => { failures++; publish(); });
      throw error;
    }
  };
  function hostScope(next: number) {
    scope.set(next);
    app.connection.set({ id: 'synthetic-media', label: 'Synthetic media', url: 'https://media.invalid', lastUsedAt: 0 });
    app.runtimeScope.set(Object.freeze({ hostID: 'synthetic-media', lease: `00000000-0000-4000-8000-${String(next + 1).padStart(12, '0')}` }));
    publish();
  }
  hostScope(0);
  function receiveCounters(value: unknown) {
    nativeSnapshot.set(JSON.stringify(value));
    if (value && typeof value === 'object' && 'playerSequence' in value) {
      const counters = value as Record<string, unknown>;
      sequenceSnapshot.set(JSON.stringify({ sequenceRun: counters.sequenceRun, sequenceActive: counters.sequenceActive, playerSequence: counters.playerSequence }));
    }
  }
  const stopCounters = host.on('fixture.media.counters', receiveCounters);
  const stopScope = host.on('fixture.media.scope', value => {
    if (value && typeof value === 'object' && 'generation' in value && typeof value.generation === 'number') hostScope(value.generation);
  });
  cleanup(() => { stopCounters(); stopScope(); clearTimeout(timer); host.call = forward; });
  async function control(action: string) {
    fixtureError.set('');
    try { receiveCounters(await native('fixture.media.control', { action })); }
    catch (error) { fixtureError.set(String(error)); }
  }
  function open(file: string) { active.set(true); path.set(`/fixture/media/${file}`); }
  function armClose() {
    clearTimeout(timer);
    const closingLease = lease;
    timer = setTimeout(() => { void native('resources.close', { lease: closingLease }).catch(error => fixtureError.set(String(error))); }, 3500);
  }
  return <View class="flex-1 bg-background p-3 gap-2" style={{ paddingTop: uikit ? safeArea().top + 8 : 8, paddingBottom: uikit ? safeArea().bottom : 0 }}>
    <View class="flex-row flex-wrap gap-2">
      <Button testID="media-open-audio" onPress={() => open('silent.wav')}><Text>WAV</Text></Button>
      <Button testID="media-open-video" onPress={() => open('neutral.mp4')}><Text>MP4</Text></Button>
      <Button testID="media-open-unsupported" onPress={() => open('unsupported.mp4')}><Text>Unsupported</Text></Button>
      <Button testID="media-open-slow" onPress={() => open('slow.mp4')}><Text>Slow</Text></Button>
    </View>
    <View class="flex-row flex-wrap gap-2">
      <Button testID="media-fail-refresh" onPress={() => { void control('fail-next-serve'); }}><Text>Fail next refresh</Text></Button>
      <Button testID="media-host" onPress={() => { void control('invalidate'); }}><Text>Host fence</Text></Button>
      <Button testID="media-arm-host" onPress={() => { void control('invalidate-after'); }}><Text>Host fence in 3.5s</Text></Button>
      <Button testID="media-inspect" onPress={() => { void control('inspect'); }}><Text>Inspect</Text></Button>
    </View>
    <View class="flex-row flex-wrap gap-2">
      <Button testID="media-hide" onPress={() => active.set(false)}><Text>Hide</Text></Button>
      <Button testID="media-show" onPress={() => active.set(true)}><Text>Show</Text></Button>
      <Button testID="media-arm-close" onPress={armClose}><Text>Stop modal in 3.5s</Text></Button>
      <Button testID="media-arm-sample" onPress={() => { void control('sample-after'); }}><Text>Sample in 3.5s</Text></Button>
      <Button testID="media-arm-sequence" onPress={() => { void control('sample-sequence'); }}><Text>Sample 8s</Text></Button>
    </View>
    <Text testID="media-js-counters" accessibilityLabel={local()} class="h-12 text-foreground" style={{ fontSize: 10 }}>{local()}</Text>
    <Text testID="media-native-counters" accessibilityLabel={nativeSnapshot() || 'No native sample'} class="h-16 text-foreground" style={{ fontSize: 10 }}>{nativeSnapshot() || 'No native sample'}</Text>
    <Text testID="media-player-sequence" accessibilityLabel={sequenceSnapshot() || 'No sample sequence'} class="h-8 text-foreground" style={{ fontSize: 9 }}>{sequenceSnapshot() || 'No sample sequence'}</Text>
    <Text testID="media-source-state" accessibilityLabel={`source path=${path()} active=${active()} scope=${scope()}`} class="text-muted-foreground" style={{ fontSize: 10 }}>{`source path=${path()} active=${active()} scope=${scope()}`}</Text>
    <If when={Boolean(fixtureError())}><Text testID="media-fixture-error" class="text-destructive">{fixtureError()}</Text></If>
    <If when={Boolean(path())} else={<Text testID="media-source-closed">Synthetic source closed</Text>}>
      <ResourcePreview directory="/fixture/media" path={path()} active={active()} onClose={() => path.set('')} />
    </If>
  </View>;
}
mount(ResourceMediaFixture);
