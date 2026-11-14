import { Scroll, Text, View, effect, signal, untracked } from 'nsh';
import { Button, Sheet } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon } from '../core/Icon';
import { EmptyState, Spinner, alpha } from '../core/ui';
import { record, textOf } from '../core/host';
import { liveStatus, type Session } from '../core/store';
import { openSession } from '../shell/nav';
import { loadChildSessions, type Conversation } from './store';

const sheetPopup = { backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 } as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Header menu «Child sessions»: the subagent sessions this chat started. */
export function ChildSessionsSheet(props: { conversation: Conversation; open: () => boolean; close: () => void }) {
  const loading = signal(false);
  const error = signal('');
  const rows = signal<Session[]>([]);

  const refresh = async () => {
    const id = props.conversation.sessionID();
    if (!id || loading()) return;
    loading.set(true);
    error.set('');
    try {
      const data = await loadChildSessions(props.conversation.directory(), id);
      rows.set(
        data.map((entry) => ({
          id: textOf(entry.id),
          title: textOf(entry.title) || t('chat.workStatus.subagent.untitled'),
          directory: textOf(record(entry).directory) || props.conversation.directory(),
          updated: Number(record(entry.time).updated) || 0,
          activity: 0,
          created: Number(record(entry.time).created) || 0,
          pinned: false,
          archived: false,
        })),
      );
    } catch (failure) {
      error.set(errorText(failure));
      rows.set([]);
    } finally {
      loading.set(false);
    }
  };

  effect(() => {
    if (!props.open()) return;
    untracked(() => void refresh());
  });

  const open = (row: Session) => {
    openSession({ id: row.id, title: row.title, directory: row.directory });
    props.close();
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
      <View style={{ height: 420, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: '600', color: colors.foreground() }}>
            {t('chat.workStatus.section.subagents')}
          </Text>
          <If when={loading()}>
            <Spinner size={14} />
          </If>
          <Button testID="children-refresh" onPress={() => void refresh()} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="refresh" size={15} tone="muted" />
          </Button>
          <Button onPress={props.close} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} tone="muted" />
          </Button>
        </View>
        <If when={!!error()}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingBottom: 6 }}>
            <Text style={{ flexShrink: 1, fontSize: 12, color: colors.destructive() }}>{error()}</Text>
            <Button onPress={() => void refresh()} style={{ paddingHorizontal: 8, paddingVertical: 2 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.foreground() }}>{t('chat.history.retry')}</Text>
            </Button>
          </View>
        </If>
        <If
          when={rows().length > 0}
          else={
            <If when={!loading() && !error()}>
              <EmptyState icon="ai-agent" title={t('chat.workStatus.section.subagents')} description={t('chat.timeline.empty.session')} />
            </If>
          }
        >
          <Scroll class="flex-1" scrollbar={false} contentStyle={{ paddingBottom: 10 }}>
            <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.25) }}>
              <Each of={rows()} key={(row) => row.id}>
                {(row) => {
                  const status = () => liveStatus(row().id);
                  return (
                    <Button
                      testID={`child-session-${row().id}`}
                      onPress={() => open(row())}
                      activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 }}
                    >
                      <Icon name="ai-agent" size={15} tone="muted" />
                      <Text style={{ flexShrink: 1, fontSize: 14, color: colors.foreground(), numberOfLines: 1 }}>{row().title}</Text>
                      <View style={{ flex: 1 }} />
                      <If when={status()?.type === 'busy' || status()?.type === 'retry'}>
                        <Spinner size={11} />
                      </If>
                      <Icon name="arrow-right-s" size={14} tone="muted" />
                    </Button>
                  );
                }}
              </Each>
            </View>
          </Scroll>
        </If>
      </View>
    </Sheet>
  );
}
