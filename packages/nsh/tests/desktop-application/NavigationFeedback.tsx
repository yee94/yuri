import { host, mount, signal, Text, View } from 'nsh';
import { NativeDesktopNavigationFeedback } from '../../desktop-navigation-feedback';
import type { DesktopNavigationState } from '../../desktop-navigation-state-core';
import { language } from '../../i18n';

const params = host.params as Record<string, unknown>;
const state = signal<DesktopNavigationState>({ restore: 'idle', write: 'idle', restoreError: null, writeError: null });
const active = signal(true);
let hold = false, reject = false;
const waiting: Array<() => void> = [];
host.on<Record<string, unknown>>('navigation.test.feedback.control', event => {
  if (event.action === 'state') state.set({ ...state(), restore: event.restore as DesktopNavigationState['restore'], write: event.write as DesktopNavigationState['write'], restoreError: new Error('/private/restore secret body'), writeError: new Error('/private/write secret body') });
  else if (event.action === 'active') active.set(event.value === true);
  else if (event.action === 'hold') hold = true;
  else if (event.action === 'reject') reject = true;
  else if (event.action === 'release') { hold = false; waiting.splice(0).forEach(done => done()); }
  else throw new Error('Unknown feedback test control');
});
async function retry(lane: string) {
  host.post('navigation.test.feedback', { lane });
  if (hold) await new Promise<void>(done => waiting.push(done));
  if (reject) throw new Error('/private/retry secret body');
}
language.set(typeof params.language === 'string' ? params.language : 'en');
mount(() => <View><Text>Feedback fixture</Text><NativeDesktopNavigationFeedback active={active()} controller={{ state, retryRestore: () => retry('restore'), retryWrite: async () => { await retry('write'); return false; } }} /></View>);
