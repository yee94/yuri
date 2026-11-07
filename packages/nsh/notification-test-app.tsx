import { mount, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { SettingsNativeNotifications } from './notification';
import type { NotificationCall } from './notification-core';

language.set('en');
const enabled = signal(false), writes = signal(0), tests = signal(0), requests = signal(0), auth = signal('notDetermined');
const call: NotificationCall = async name => {
  if (name === 'notification.status') return { authorization: auth(), alert: 'enabled', sound: 'enabled', badge: 'unsupported', backgroundPush: false };
  if (name === 'notification.request') { requests.set(requests() + 1); auth.set('denied'); return { authorization: 'denied', alert: 'disabled', sound: 'disabled', badge: 'unsupported', backgroundPush: false }; }
  if (name === 'notification.openSettings') return null;
  if (name === 'notification.test') { tests.set(tests() + 1); return { result: 'scheduled' }; }
  throw new Error('Unexpected synthetic notification operation');
};
function Fixture() {
  const active = signal(true);
  return <Scroll class="flex-1" contentClass="p-5 gap-4">
    <View><Text>{`enabled=${enabled()} writes=${writes()} requests=${requests()} tests=${tests()}`}</Text></View>
    <Button testID="notification-fixture-authorize" onPress={() => { auth.set('authorized'); active.set(false); requestAnimationFrame(() => active.set(true)); }}><Text>Grant synthetic permission</Text></Button>
    <SettingsNativeNotifications hostID="fixture-host" enabled={enabled()} active={active()} current={() => true} call={call} onEnabledChange={value => { enabled.set(value); writes.set(writes() + 1); }} />
  </Scroll>;
}
mount(Fixture);
