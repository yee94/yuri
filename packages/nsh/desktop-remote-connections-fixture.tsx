import { effect, mount, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { createDesktopRemoteConnections } from './desktop-remote-connections';
import type { DesktopRemoteConnectionsPort, DesktopSshSnapshot } from './desktop-remote-connections-core';
import { createDesktopSettingsContentProtection } from './desktop-settings-content-core';
import { DesktopSettingsPublisher } from './desktop-settings-publisher';
import { language } from './i18n';

// Memory-only synthetic actor port. Never imported by the product root.
function Fixture() {
  language.set('en');
  let serial = 0, attempts = 0;
  const active = signal(true), revision = signal(0), calls = signal('');
  let value: DesktopSshSnapshot = { revision: 1, saving: false, receipts: [], statuses: [], instances: [{ id: 'fixture', label: 'Fixture SSH', host: 'ssh.example.invalid', user: 'fixture', port: 22, remotePort: 3210, localPort: 0, managed: true }] };
  const audit = (event: string) => calls.set(calls() + event + ';');
  const port: DesktopRemoteConnectionsPort = {
    current: () => true, newID: () => `fixture-${++serial}`,
    async read() { return value; },
    async save(input) { audit('save'); const before = value.instances.find(row => row.id === input.instance.id); value = { ...value, revision: value.revision + 1, receipts: [...value.receipts, input.requestID], instances: before ? value.instances.map(row => row.id === input.instance.id ? input.instance : row) : [...value.instances, input.instance] }; return value; },
    async remove(input) { audit('remove'); value = { ...value, revision: value.revision + 1, receipts: [...value.receipts, input.requestID], instances: value.instances.filter(row => row.id !== input.id), statuses: value.statuses.filter(row => row.id !== input.id) }; return value; },
    async start(input) { audit(input.intent); const status = { id: input.id, attempt: ++attempts, requestID: input.requestID, phase: input.intent === 'check' ? 'checked' as const : 'ready' as const, running: false, connectionID: input.intent === 'check' ? null : 'fixture-connection', error: null, retry: 0 }; value = { ...value, receipts: [...value.receipts, input.requestID], statuses: [...value.statuses.filter(row => row.id !== input.id), status] }; return value; },
    async cancel(input) { audit('cancel'); value = { ...value, statuses: value.statuses.map(row => row.id === input.id ? { ...row, phase: 'idle', connectionID: null } : row) }; return value; },
    async syncPreview(input) { audit(`preview-${input.direction}`); return { runID: input.runID, direction: input.direction, phase: 'review', files: input.selections.fileGroups[0] ? [{ name: 'opencode.jsonc', bytes: 42 }] : [], directories: [{ name: 'skills', fileCount: 1, bytes: 11 }], agentsRoot: { fileCount: 2, bytes: 12 }, deletes: ['config.json'] }; },
    async syncApply(input) { audit('sync-apply'); return { runID: input.runID, phase: 'success' }; },
    async syncStatus(input) { return { runID: input.runID, phase: 'success' }; },
    async syncHistory(input) { audit('history'); return { direction: input.direction, runs: [{ schema: 1, runID: 'prior-native-run', phase: 'success', startedAt: '00000000000000000001', endedAt: '00000000000000000002', files: 2, bytes: 44, applied: 2 }] }; },
  };
  const owner = createDesktopRemoteConnections(port, { connectionMutation: mutation => mutation.dispatch() }), protection = createDesktopSettingsContentProtection({ page: 'remote-instances', active, changed: () => revision.set(revision() + 1), unavailable: async () => {} });
  const state = signal(owner.controller.state()); owner.controller.subscribe(() => state.set(owner.controller.state()));
  effect(() => { void revision(); void state(); });
  return <View class="flex-1 bg-background">
    <Text testID="ssh-fixture-audit">{calls()}</Text>
    <Text>{`guard=${revision() >= 0 ? protection.snapshot().status : ''};dirty=${protection.snapshot().dirty};pending=${protection.snapshot().pending}`}</Text>
    <Button testID="ssh-fixture-hide" onPress={() => active.set(!active())}><Text>Toggle fixture active</Text></Button>
    <Button testID="ssh-fixture-fr" onPress={() => language.set('fr')}><Text>French fixture</Text></Button>
    <DesktopSettingsPublisher.Provider value={protection}><Scroll class="flex-1" contentClass="p-5 gap-3">{owner.slot({ get active() { return active(); } })}</Scroll></DesktopSettingsPublisher.Provider>
  </View>;
}
mount(Fixture);
