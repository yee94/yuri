import { host, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { NativeDesktopContext, type DesktopContextAppearance } from './desktop-context';
import type { DesktopContextChat, DesktopContextOwner } from './desktop-context-core';
import type { ContextMessageCommit } from './context-usage-route-core';
import { contextUsageFixtureSnapshot } from './context-usage-fixture-data';
import { messageFrom, type Message } from './model';
import { language } from './i18n';
import dark from '../ui/src/lib/theme/themes/yuri-2-dark.json';

/** Synthetic original-owner boundary; renders the real workbench component without app/credentials. */
const data = contextUsageFixtureSnapshot(), rows = signal(data.messages.map(entry => messageFrom({ info: entry.info, parts: entry.parts })!));
const active = signal(false), interactive = signal(true), current = signal(true), draft = signal('Keep original composer'), noise = signal(0);
const scope = signal({ host: { hostID: data.scope.hostID, lease: 'fixture-lease' }, authorityKey: 'fixture-authorization', sessionID: data.scope.sessionID, directory: data.scope.directory });
const palette = { primary: dark.colors.primary.base, warning: dark.colors.status.warning, success: dark.colors.status.success, muted: dark.colors.surface.mutedForeground, subtle: dark.colors.surface.subtle };
const appearance = signal<DesktopContextAppearance>({ showAssistantTps: true, timeFormatPreference: '24h', contextUsageTokens: { dark: palette, light: palette } });
const listeners = new Set<(commit: ContextMessageCommit) => void>();
let projection: DesktopContextOwner | null = null, reads = 0, scans = 0, subscriptions = 0, failed = false;
const audit = (event: string, value: unknown = null) => host.post('desktop.context.audit', { event, value });
const messages = Object.assign(() => { scans++; return rows(); }, { set: rows.set, update: rows.update });
const chat: DesktopContextChat = { messageScope: data.scope, messages, messagesResolved: signal(true), messageReadError: signal(''),
  observeMessageCommits(listener) { subscriptions++; listeners.add(listener); return () => { listeners.delete(listener); }; },
  async load() { audit('original-message-retry'); chat.messageReadError.set(''); },
};
const emit = (commit: ContextMessageCommit) => listeners.forEach(listener => listener(commit));
async function read(path: string) {
  reads++; audit('metadata-read', path);
  if (failed) throw new Error('Synthetic metadata failure');
  if (path.startsWith('/api/session/')) return { ...data.session, directory: data.scope.directory };
  if (path.startsWith('/api/config/catalog/providers?')) return { schemaVersion: 1, providers: data.providers.map(provider => ({ ...provider, models: Object.fromEntries(provider.models.map(model => [model.id, model])) })) };
  throw new Error('Context fixture forbids unowned requests');
}
host.on<{ action: string; value?: unknown }>('desktop.context.control', async event => {
  if (event.action === 'active') active.set(event.value === true);
  else if (event.action === 'interactive') interactive.set(event.value === true);
  else if (event.action === 'retire') current.set(false);
  else if (event.action === 'noise') noise.update(value => value + 1);
  else if (event.action === 'language') language.set(String(event.value));
  else if (event.action === 'tps') appearance.update(value => ({ ...value, showAssistantTps: event.value === true }));
  else if (event.action === 'fail') { failed = true; await projection?.refresh(); }
  else if (event.action === 'recover') failed = false;
  else if (event.action === 'retry-messages') { chat.messageReadError.set('Synthetic message read failure'); emit({ kind: 'snapshot', error: 'Synthetic message read failure' }); }
  else if (event.action === 'empty') { rows.set([]); emit({ kind: 'snapshot' }); }
  else if (event.action === 'patch') {
    const previous = rows().at(-1)!;
    const updated: Message = { ...previous, contextLive: true, text: 'Latest original Chat commit', content: [{ id: 'live', type: 'text', text: 'Latest original Chat commit' }] };
    rows.update(value => [...value.slice(0, -1), updated]); emit({ kind: 'patch', messages: [updated] });
  } else if (event.action === 'mismatch') scope.update(value => ({ ...value, sessionID: 'unowned-session' }));
  else if (event.action === 'stats') audit('stats', { reads, scans, subscriptions, listeners: listeners.size, operations: projection?.owner.operations() });
  else throw new Error('Unknown desktop Context fixture control');
});
language.set('en');
mount(() => <View class="flex-1 bg-background">
  <Input testID="desktop-context-fixture-composer" value={draft()} onChange={event => draft.set(event.value)} />
  <Text testID="desktop-context-fixture-noise">{noise()}</Text>
  <NativeDesktopContext scope={scope()} chat={chat} current={current} active={active()} interactive={interactive()} read={read} appearance={appearance()} onOwner={value => { projection = value; }} />
</View>);
