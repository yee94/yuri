import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { createNativeNotificationRoot } from './notification-root';
import { notificationAdmission, createNotificationAdmission } from '../web/server/lib/notifications/admission-event.js';
import type { NotificationCall, NotificationScope } from './notification-core';
import type { NotificationRecoveryRecord } from './notification-global-recovery';

// Prepared engine fixture only. Every Host/native boundary is injected; no notification is sent to the OS.
language.set('en');
function Fixture() {
  const scope = signal<NotificationScope>({ hostID: 'fixture-host', generation: 1 });
  const sends = signal(0), opens = signal(0), acks = signal(0), reads = signal(0);
  let pending: NotificationRecoveryRecord | null = null;
  const receipt = '12345678-1234-1234-1234-123456789abc';
  const values = (['completion', 'subtask', 'error', 'question', 'permission', 'goal', 'assistant', 'schedule'] as const).map(kind => {
    if (kind === 'assistant') return createNotificationAdmission(kind, { kind: 'assistant', id: 'bot' }, { type: 'assistant', assistantID: 'bot', turnID: 'turn', status: 'complete', publication: 'published' })!;
    if (kind === 'schedule') return createNotificationAdmission(kind, { kind: 'schedule', id: 'task' }, { type: 'schedule', projectID: 'project', taskID: 'task', runID: 'run', trigger: 'scheduled', resultOwner: 'unowned', status: 'success' })!;
    const sessionID = kind === 'subtask' ? 'child' : 'session';
    return createNotificationAdmission(kind, { kind: 'session', id: sessionID }, { type: 'session', sessionID, directory: '/fixture', parentID: kind === 'subtask' ? 'session' : null, boundaryID: 'boundary' })!;
  });
  const call: NotificationCall = async (name, body) => {
    if (name === 'notification.configure') return { lease: `lease-${scope().generation}` };
    if (name === 'notification.live') {
      if (!notificationAdmission(body?.admission)) throw new Error('fixture_invalid_proof');
      sends.set(sends() + 1); return { result: 'suppressed' };
    }
    if (name === 'notification.launch.peek') return { record: pending };
    if (name === 'notification.launch.claim') return { record: pending, route: { hostID: scope().hostID, lease: `lease-${scope().generation}`, target: pending?.admission.target } };
    if (name === 'notification.launch.ack' && body?.expectedRevision === pending?.revision) { acks.set(acks() + 1); pending = null; return { ok: true }; }
    throw new Error('fixture_unexpected_boundary');
  };
  const root = createNativeNotificationRoot({ scope, authorizationID: () => 'fixture-authorization', call, now: () => 100,
    captureRequest: () => async (path, method = 'GET') => {
      if (path !== '/api/config/settings' || method !== 'GET') throw new Error('fixture_no_mutations');
      reads.set(reads() + 1); return { nativeNotificationsEnabled: true, notifyOnSubtasks: true };
    },
    sessions: () => [{ id: 'session', directory: '/fixture', title: 'Synthetic', updated: 1 }],
    lookup: async (id, directory, valid) => valid() && id === 'child' && directory === '/fixture' ? [{ id, directory, parentID: 'session', title: 'Child', updated: 1 }] : [],
    catalog: () => [{ target: { kind: 'assistant', id: 'bot' } }, { target: { kind: 'schedule', id: 'task' }, projectID: 'project' }],
    catalogReady: async () => {}, resolve: identity => [identity.kind],
    open: (_value, valid) => { if (!valid()) return false; opens.set(opens() + 1); return true; },
  });
  const Feedback = root.Feedback;
  return <View class="flex-1 p-5 gap-4">
    <Text testID="notification-root-fixture-state">{`sends=${sends()} opens=${opens()} acks=${acks()} reads=${reads()} ready=${root.state().ready}`}</Text>
    <Button testID="notification-root-fixture-admit" onPress={() => { for (const admission of values) root.onEvent({ key: 'global', type: 'yuri:notification-admitted', body: admission, directory: '' }, scope()); }}><Text>Admit eight synthetic proofs</Text></Button>
    <Button testID="notification-root-fixture-raw" onPress={() => { for (let n = 0; n < 500; n++) root.onEvent({ key: 'global', type: 'session.execution.succeeded', body: { sessionID: 'session' }, id: `raw-${n}`, directory: '/fixture' }, scope()); }}><Text>Ignore raw events</Text></Button>
    <Button testID="notification-root-fixture-cold" onPress={() => {
      pending = { v: 1, receipt, revision: 1, connectionID: scope().hostID, authorizationID: 'fixture-authorization', admission: values.at(-1)!, createdAt: 1, expiresAt: 1000 };
      void root.recover();
    }}><Text>Resolve synthetic protected receipt</Text></Button>
    <Button testID="notification-root-fixture-rebind" onPress={() => scope.set({ ...scope(), generation: scope().generation + 1 })}><Text>Replace synthetic scope</Text></Button>
    <Feedback />
  </View>;
}
mount(Fixture);
