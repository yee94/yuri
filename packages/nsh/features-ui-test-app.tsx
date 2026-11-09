import { mount, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { BotEditor, TaskEditor } from './features';
import { app } from './state';
import { language } from './i18n';
import type { Row } from './model';

language.set('en');
app.connection.set({ id: 'features-fixture', label: 'Fixture', url: 'https://host.example', lastUsedAt: 1 });
app.projects.set([{ id: 'project', path: '/first-project', name: 'First project' }]);
const bot: Row = { id: 'bot', revision: 1, name: 'Fixture Bot', defaultPrompt: 'Prompt', workspacePath: null, managedWorkspacePath: '/managed', providerID: 'fixture', modelID: 'model', agent: 'preserve-agent', mode: 'continuous' };
const item: Row = { projectId: 'project', task: { id: 'task', name: 'Fixture Task', enabled: true, schedule: { kind: 'cron', cron: '0 9 * * MON-FRI', timezone: 'America/New_York' }, execution: { prompt: 'Inspect schedule', providerID: 'fixture', modelID: 'model', agent: 'build', goalEnabled: true } } };
mount(() => {
  const nav = createNavStack<{ kind: 'root' | 'bot' | 'task' | 'daily' | 'once' }>([{ kind: 'root' }]);
  return <NavStack state={nav} class="flex-1">{route => {
    if (route.kind === 'bot') return <BotEditor bot={bot} onDone={() => nav.pop()} />;
    if (route.kind === 'task') return <TaskEditor item={item} onDone={() => nav.pop()} />;
    if (route.kind === 'daily' || route.kind === 'once') return <TaskEditor item={{ ...item, task: { ...item.task as Row, schedule: route.kind === 'daily' ? { kind: 'daily', times: ['09:00'], timezone: 'UTC' } : { kind: 'once', date: '2026-11-08', time: '09:00', timezone: 'UTC' } } }} onDone={() => nav.pop()} />;
    return <NavPage title="Features fixture" headerBackTitle=""><View class="gap-3"><Button testID="features-open-bot" onPress={() => nav.push({ kind: 'bot' })}><Text>Open Bot editor</Text></Button><Button testID="features-open-task" onPress={() => nav.push({ kind: 'task' })}><Text>Open Task editor</Text></Button><Button testID="features-open-daily" onPress={() => nav.push({ kind: 'daily' })}><Text>Open daily editor</Text></Button><Button testID="features-open-once" onPress={() => nav.push({ kind: 'once' })}><Text>Open once editor</Text></Button></View></NavPage>;
  }}</NavStack>;
});
