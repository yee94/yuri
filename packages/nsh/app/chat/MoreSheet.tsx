import { Text, View, signal } from 'nsh';
import { AlertDialog, Sheet } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { ActionRow, alpha } from '../core/ui';
import { compactSession, type Conversation } from './store';

const sheetPopup = { backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 } as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;

/** The header's workspace tools menu (Web mobile overflow menu's chat entries). */
export function MoreSheet(props: {
  conversation: Conversation;
  open: () => boolean;
  close: () => void;
  onNew: () => void;
  onChanges: () => void;
  onMcp: () => void;
  onTimeline: () => void;
  onChildren: () => void;
  onSync: () => void;
  dirtyChanges: () => number;
}) {
  const compacting = signal(false);
  const hasSession = () => !!props.conversation.sessionID();
  const busy = () => props.conversation.busy();

  const confirmCompact = async () => {
    if (!hasSession() || busy() || compacting()) return;
    props.close();
    const answer = await AlertDialog.show({
      title: t('chat.leaderKey.action.compact'),
      description: t('chat.commandAutocomplete.command.compactDescription'),
      actions: [
        { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
        { id: 'compact', label: t('gitView.common.done') },
      ],
    });
    if (answer.action !== 'compact') return;
    compacting.set(true);
    try {
      await compactSession(props.conversation);
    } catch (error) {
      props.conversation.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      compacting.set(false);
    }
  };

  return (
    <Sheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.close();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View style={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 'env(safe-area-inset-bottom)', gap: 6 }}>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.foreground(), paddingHorizontal: 8, paddingBottom: 4 }}>
          {t('mobile.menu.titleAria')}
        </Text>
        <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.4) }}>
          <ActionRow testID="chat-more-new" icon="chat-new" label={t('mobile.menu.newSession')} onPress={props.onNew} />
          <ActionRow
            testID="chat-more-changes"
            icon="git-branch"
            label={props.dirtyChanges() > 0 ? `${t('mobile.menu.changes')} · ${props.dirtyChanges()}` : t('mobile.menu.changes')}
            onPress={props.onChanges}
            divider
          />
          <ActionRow testID="chat-more-mcp" icon="tools" label={t('mobile.menu.mcp')} onPress={props.onMcp} divider />
          <ActionRow
            testID="chat-more-sync"
            icon="refresh"
            label={t('sessions.sidebar.session.menu.refreshTranscript')}
            disabled={!hasSession()}
            onPress={props.onSync}
            divider
          />
          <ActionRow
            testID="chat-more-compact"
            icon="fold-vertical"
            label={t('chat.leaderKey.action.compact')}
            disabled={!hasSession() || busy()}
            spinning={compacting()}
            onPress={() => void confirmCompact()}
            divider
          />
          <ActionRow
            testID="chat-more-timeline"
            icon="history"
            label={t('chat.timeline.title')}
            disabled={!hasSession()}
            onPress={props.onTimeline}
            divider
          />
          <ActionRow
            testID="chat-more-children"
            icon="ai-agent"
            label={t('chat.workStatus.section.subagents')}
            disabled={!hasSession()}
            onPress={props.onChildren}
            divider
          />
        </View>
      </View>
    </Sheet>
  );
}
