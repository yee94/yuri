import { Text, View, resource } from 'nsh';
import { NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { QuietButton, fontSize } from '../core/ui';
import { ChatPage } from '../chat/ChatPage';
import type { AssistantRoute } from '../shell/nav';
import { assistantByID, ensureAssistantSession, markAssistantRead } from './data';

/**
 * A bot conversation is its bound OpenCode session; the transcript surface is the
 * shared chat page. Bot-specific composer chrome lands with the chat rewrite.
 */
export function AssistantConversationPage(props: { route: AssistantRoute }) {
  const binding = resource(
    () => props.route.assistantID,
    async (id) => {
      const assistant = assistantByID(id);
      if (assistant && assistant.unreadCount > 0) void markAssistantRead(assistant).catch(() => {});
      return ensureAssistantSession(id);
    },
  );

  return (
    <View class="flex-1" style={{ backgroundColor: colors.background() }}>
      <If
        when={!!binding()?.sessionID}
        else={
          <NavPage title={props.route.title} class="flex-1" style={{ backgroundColor: colors.background() }}>
            <View class="flex-1" style={{ alignItems: 'center', justifyContent: 'center', padding: space.pageInset, gap: 10 }}>
              <If when={!!binding.error()}>
                <Icon name="error-warning" size={26} color={() => colors.destructive()} />
                <Text style={{ fontSize: fontSize.entityTitle, color: colors.destructive(), textAlign: 'center' }}>
                  {binding.error() instanceof Error
                    ? (binding.error() as Error).message
                    : t('assistants.state.messagesFailed')}
                </Text>
                <QuietButton label={() => t('assistants.actions.retry')} onPress={() => binding.refetch()} />
              </If>
              <If when={!binding.error()}>
                <Icon name="ai-agent" size={26} tone="muted" />
              </If>
            </View>
          </NavPage>
        }
      >
        <ChatPage
          route={{
            kind: 'chat',
            sessionID: binding()?.sessionID ?? null,
            title: props.route.title,
            directory: binding()?.directory ?? '',
            draft: false,
          }}
        />
      </If>
    </View>
  );
}
