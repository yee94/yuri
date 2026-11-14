import { Text, View, signal } from 'nsh';
import { NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { QuietButton, Spinner, fontSize } from '../core/ui';
import { activeStack, type AssistantRoute } from '../shell/nav';
import { assistantByID, ensureAssistantSession, markAssistantRead } from './data';

/**
 * A bot conversation is its bound OpenCode session: this route resolves the
 * binding, then becomes the ordinary chat route so the transcript, header and
 * back navigation are exactly a session's.
 */
export function AssistantConversationPage(props: { route: AssistantRoute }) {
  const phase = signal<'loading' | 'ready' | 'error'>('loading');
  const failure = signal('');
  let started = false;

  const load = async () => {
    phase.set('loading');
    failure.set('');
    try {
      const assistant = assistantByID(props.route.assistantID);
      if (assistant && assistant.unreadCount > 0) {
        await markAssistantRead(assistant).catch(() => {});
      }
      const binding = await ensureAssistantSession(props.route.assistantID);
      if (!binding.sessionID) throw new Error(t('assistants.state.messagesFailed'));
      phase.set('ready');
      activeStack().replace({
        kind: 'chat',
        sessionID: binding.sessionID,
        title: props.route.title,
        directory: binding.directory,
        draft: false,
      });
    } catch (error) {
      failure.set(error instanceof Error ? error.message : String(error));
      phase.set('error');
    }
  };

  if (!started) {
    started = true;
    void load();
  }

  return (
    <NavPage
      title={props.route.title}
      headerBackTitle={t('assistants.title')}
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
    >
      <View
        testID="assistant-conversation"
        class="flex-1"
        style={{ alignItems: 'center', justifyContent: 'center', padding: space.pageInset, gap: 10 }}
      >
        <If when={phase() === 'error'}>
          <Icon name="error-warning" size={26} color={() => colors.destructive()} />
          <Text style={{ fontSize: fontSize.entityTitle, color: colors.destructive(), textAlign: 'center' }}>
            {failure()}
          </Text>
          <QuietButton label={() => t('assistants.actions.retry')} onPress={() => void load()} />
        </If>
        <If when={phase() === 'loading'}>
          <Spinner size={20} />
        </If>
      </View>
    </NavPage>
  );
}
