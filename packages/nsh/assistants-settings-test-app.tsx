import { mount, Text } from 'nsh';
import { createNavStack, NavPage, NavStack } from 'nsh/base';
import { AssistantDetails, AssistantSettings } from './assistants';
import { BotEditor } from './features';
import { ScheduledTaskDetail } from './schedules';
import { language } from './i18n';
import type { ChatTarget, Row } from './model';
import { app } from './state';

type Route = { kind: 'settings' } | { kind: 'bot'; bot: Row } | { kind: 'create' } | { kind: 'chat'; target: ChatTarget } | { kind: 'task'; item: Row };
function AssistantSettingsTestApp() {
  language.set('en');
  app.connection.set({ id: 'fixture-settings', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 });
  app.projects.set([{ id: 'project', name: 'Native fixture project', path: '/workspace/project' }]);
  app.tab.set(3);
  const nav = createNavStack<Route>([{ kind: 'settings' }]);
  const onOpenChat = (target: ChatTarget) => nav.push({ kind: 'chat', target });
  return <NavStack state={nav} class="flex-1">{route => {
    if (route.kind === 'create') return <BotEditor onDone={() => nav.pop()} />;
    if (route.kind === 'chat') return <NavPage title="Opened contact" headerBackTitle=""><Text testID="opened-contact">{route.target.id}</Text></NavPage>;
    if (route.kind === 'task') return <ScheduledTaskDetail active={nav.routes().at(-1) === route} item={route.item} onEdit={() => {}} onOpenSession={onOpenChat} onDeleted={() => nav.pop()} />;
    if (route.kind === 'bot') return <AssistantDetails active={nav.routes().at(-1) === route} bot={route.bot} onDone={() => nav.pop()} onOpenChat={onOpenChat} onOpenTask={item => nav.push({ kind: 'task', item })} historyActions={{ clearLabel: 'Clear chat history', confirmDescription: 'Delete this bot’s chat history? This cannot be undone. The bot and its configuration will remain.', clearedLabel: 'Chat history cleared' }} />;
    return <AssistantSettings active={nav.routes().at(-1) === route} onCreate={() => nav.push({ kind: 'create' })} onEdit={bot => nav.push({ kind: 'bot', bot })} />;
  }}</NavStack>;
}
mount(AssistantSettingsTestApp);
