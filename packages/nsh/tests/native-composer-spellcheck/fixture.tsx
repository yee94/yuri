import { cleanup, host, keyboardFrame, lifecycle, mount, nativeComponent, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { NativeComposerSpellcheck } from '../../native-composer-spellcheck';
import { NativeInputMetadata } from '../../native-input-metadata';
import { nativeComposerSurface } from '../../composer-surface';

type AckStatus = { revision: number; phase: 'idle' | 'pending' | 'accepted' | 'failed' | 'rejected'; code: string };
const Readback = nativeComponent<{ config: { ownerID: string; inputID: string; generation: number }; ackStatus: AckStatus }>('yuri.fixture.composer.readback', { props: ['config', 'ackStatus'] });
const errorCodes: Record<string, string> = { ERR_ACCESS_DENIED: 'ack_access_denied', ERR_NSH_HOST_ERROR: 'ack_host_error', ETIMEDOUT: 'ack_timeout', ERR_FEATURE_UNAVAILABLE_ON_PLATFORM: 'ack_unavailable' };

/** Isolated test copy of the real NSH Input + original production registrations, without app state or Host. */
function Fixture() {
  const draft = signal(''), hostRevision = signal(0);
  const ackStatus = signal<AckStatus>({ revision: 0, phase: 'idle', code: 'none' });
  const generation = 1;
  let alive = true;
  cleanup(() => { alive = false; });
  cleanup(host.on('fixture.composer.hostChanged', async value => {
    if (!value || typeof value !== 'object' || !('revision' in value) || !Number.isSafeInteger(value.revision) || (value.revision as number) <= 0 || (value.revision as number) > 1_000_000) return;
    const revision = value.revision as number;
    hostRevision.set(revision);
    ackStatus.set({ revision, phase: 'pending', code: 'none' });
    try {
      const response = await host.call('fixture.composer.hostAdopted', { revision });
      if (!alive || hostRevision() !== revision) return;
      if (!response || typeof response !== 'object' || Object.keys(response).length !== 2 || !('revision' in response) || response.revision !== revision || !('accepted' in response) || typeof response.accepted !== 'boolean') {
        ackStatus.set({ revision, phase: 'failed', code: 'ack_reply_invalid' }); return;
      }
      ackStatus.set({ revision, phase: response.accepted ? 'accepted' : 'rejected', code: response.accepted ? 'none' : 'ack_reply_rejected' });
    } catch (error) {
      if (!alive || hostRevision() !== revision) return;
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && Object.hasOwn(errorCodes, error.code) ? errorCodes[error.code] : undefined;
      ackStatus.set({ revision, phase: 'failed', code: code ?? 'ack_unknown' });
    }
  }));
  return <View class="flex-1 bg-background px-3" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 20px)', paddingBottom: keyboardFrame().height > 0 ? 'calc(env(keyboard-inset-height) + 12px)' : 'calc(env(safe-area-inset-bottom) + 16px)' }}>
    <Text class="text-foreground">Composer spellcheck UIKit fixture</Text>
    <Text testID="probe-host-revision" class="text-muted-foreground">Synthetic Host revision {hostRevision()}</Text>
    <If when={host.params.composerReadbackEnabled === true}><Text testID="probe-host-ack" class="text-muted-foreground">ACK {ackStatus().phase} revision:{ackStatus().revision} code:{ackStatus().code}</Text></If>
    <View class="flex-1" />
    <View testID="composer-glass" style={nativeComposerSurface} class="px-3 pt-1 pb-1">
      <NativeInputMetadata ownerID="composer-glass" inputID="composer" label="Write a message" active={lifecycle() === 'active'} />
      <NativeComposerSpellcheck ownerID="composer-glass" inputID="composer" />
      <If when={host.params.composerReadbackEnabled === true}><Readback config={{ ownerID: 'composer-glass', inputID: 'composer', generation }} ackStatus={ackStatus()} accessible={false} accessibilityElementsHidden style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} /></If>
      <Input testID="composer" accessibilityLabel="Write a message" multiline class="text-foreground min-h-[52px] max-h-36 py-[10px]" style={{ backgroundColor: 'transparent', borderWidth: 0 }} value={draft()} onChange={event => draft.set(event.value)} placeholder="Write a message" />
    </View>
  </View>;
}
mount(Fixture);
