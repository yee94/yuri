import { cleanup, host, mount, signal, Text, untracked, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeComposerTimeline, type NativeTimelineOperation } from './composer-timeline';
import { messageFrom, record } from './model';
import type { NativeLocalCommandOutcome } from './composer-local-commands';

function Fixture() {
  const open = signal(false), scope = signal('scope-a'), draft = signal(''), reads = signal(0), events = signal('none'), calls = signal(0);
  const messages = signal([messageFrom({ id: 'z-first', type: 'user', content: [{ type: 'text', text: 'first prefix' }, { type: 'text', text: 'needle second part' }], time: { created: 1700000000000 } })!,
    messageFrom({ id: 'assistant', type: 'assistant', text: 'not a user' })!, messageFrom({ id: 'b-last', type: 'user', text: 'last question', time: { created: 1700100000000 } })!]);
  const more = signal(true), loading = signal(false), failJump = signal(false), failLoad = signal(false);
  let complete!: (outcome: NativeLocalCommandOutcome) => void, older: (() => void) | undefined, receipt: NativeTimelineOperation | undefined;
  let owner: { settleUnknown: (operation: NativeTimelineOperation, outcome: 'accepted' | 'rejected') => boolean } | undefined;
  cleanup(host.on('timeline-fixture', event => {
    switch (record(event).action) {
      case 'jump-fails': failJump.set(!failJump()); break;
      case 'load-fails': failLoad.set(!failLoad()); break;
      case 'finish-older': older?.(); break;
      case 'finish': complete?.({ status: 'accepted' }); break;
      case 'unknown': complete?.({ status: 'unknown' }); break;
      case 'scope': scope.set('scope-b'); break;
      case 'resolve': if (receipt) owner?.settleUnknown(receipt, 'accepted'); break;
    }
  }));
  return <View>
    <Text>{`reads:${reads()} calls:${calls()} event:${events()}`}</Text><Input testID="ordinary" value={draft()} onChange={event => draft.set(event.value)} />
    <Button testID="open" onPress={() => open.set(true)}><Text>Open</Text></Button>
    <Button testID="change-scope" onPress={() => scope.set('scope-b')}><Text>Scope</Text></Button>
    <Button testID="jump-fails" onPress={() => failJump.set(!failJump())}><Text>Jump failure</Text></Button>
    <Button testID="load-fails" onPress={() => failLoad.set(!failLoad())}><Text>Load failure</Text></Button>
    <Button testID="finish-older" onPress={() => older?.()}><Text>Older complete</Text></Button>
    <Button testID="finish" onPress={() => complete?.({ status: 'accepted' })}><Text>Finish</Text></Button>
    <Button testID="unknown" onPress={() => complete?.({ status: 'unknown' })}><Text>Unknown</Text></Button>
    <Button testID="resolve" onPress={() => { if (receipt) owner?.settleUnknown(receipt, 'accepted'); }}><Text>Resolve</Text></Button>
    <NativeComposerTimeline open={open()} active scope={scope()} messages={() => { untracked(() => reads.set(reads() + 1)); return messages(); }}
      canLoadEarlier={more()} isLoadingEarlier={loading()} onLoadEarlier={async () => {
        if (failLoad()) throw new Error('synthetic read failure');
        loading.set(true); await new Promise<void>(resolve => { older = resolve; });
        messages.set([messageFrom({ id: 'older', type: 'user', text: 'older question', time: { created: 1600000000000 } })!, ...messages()]); loading.set(false); more.set(false); return true;
      }}
      onScrollToMessage={async id => { calls.set(calls() + 1); events.set(`jump:${id}`); return !failJump(); }}
      canFork canRevert onRevertMessage={id => { calls.set(calls() + 1); events.set(`revert:${id}`); return new Promise(resolve => { complete = resolve; }); }}
      onForkMessage={id => { calls.set(calls() + 1); events.set(`fork:${id}`); return new Promise(resolve => { complete = resolve; }); }}
      onScrollByTurnOffset={() => events.set('previous')} onResumeToLatest={() => events.set('latest')}
      onOpenChange={value => open.set(value)} onUnknown={operation => { receipt = operation; events.set('unknown'); }} onOwner={value => { owner = value; }} />
  </View>;
}
mount(Fixture);
