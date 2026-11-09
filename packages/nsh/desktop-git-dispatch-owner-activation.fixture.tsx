import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeNewSessionPage } from './new-session-page';
import type { NativeNewSessionOwner } from './new-session';
import { request } from './runtime';
import { app, loadConnections } from './state';

/** A retained desktop root first becomes active after its initial mount. */
function Fixture() {
  const ready = signal(false), active = signal(false), owner = signal('none'), control = signal('idle');
  let currentOwner: NativeNewSessionOwner | undefined;
  async function changeAuthority(kind: 'lease' | 'origin' | 'authorization' | 'restore') {
    await currentOwner?.durable.flush(); await request(`/__fixture/owner/${kind}`); await loadConnections(); control.set(`${kind}-done`);
  }
  const project = { id: 'fixture-project', name: 'Native draft project', path: '/fixture/project' };
  void loadConnections().then(() => { app.projects.set([project]); ready.set(true); });
  return <View class="flex-1"><If when={ready()}><NativeNewSessionPage active={active()} onDesktopOwner={event => { if (event.type === 'register') currentOwner = event.owner; else if (currentOwner === event.owner) currentOwner = undefined; owner.set(event.type === 'register' ? 'registered' : 'retired'); }} onOpenChat={() => { throw new Error('Opening a draft must not send'); }} /></If>
    <Text testID="activation-owner">{owner()}</Text><Button testID="activate-draft" onPress={() => active.set(true)}><Text>Activate draft</Text></Button>
    <Text testID="activation-control">{control()}</Text><Button testID="activation-lease" onPress={() => { void changeAuthority('lease'); }}><Text>Renew synthetic lease</Text></Button>
    <Button testID="activation-authorization" onPress={() => { void changeAuthority('authorization'); }}><Text>Change synthetic authorization</Text></Button><Button testID="activation-origin" onPress={() => { void changeAuthority('origin'); }}><Text>Change synthetic origin</Text></Button><Button testID="activation-restore" onPress={() => { void changeAuthority('restore'); }}><Text>Restore synthetic identity</Text></Button>
  </View>;
}
mount(Fixture);
