import { Scroll, Text, View, signal, windowSize } from 'nsh';
import { Button, Input, Sheet } from 'nsh/base';
import { t, currentLocale } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon } from '../core/Icon';
import { EmptyState, alpha } from '../core/ui';
import { formatTimeForLocale } from '../../../ui/src/lib/time-format-core';
import type { Conversation } from './store';

type TimelineEntry = { id: string; text: string; created: number };

const sheetPopup = { backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 } as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;

const field = {
  minHeight: 38,
  borderRadius: 10,
  paddingHorizontal: 10,
  fontSize: 14,
  color: colors.foreground(),
  backgroundColor: alpha(colors.muted(), 0.65),
  placeholderColor: colors.mutedForeground(),
} as const;

/** Header menu «Timeline»: the session's user turns, tap to reveal one in the transcript. */
export function TimelineSheet(props: { conversation: Conversation; open: () => boolean; close: () => void }) {
  const query = signal('');
  const entries = (): TimelineEntry[] =>
    props.conversation
      .messages()
      .filter((entry) => entry.role === 'user')
      .map((entry) => ({
        id: entry.id,
        text: entry.text(),
        created: Number(entry.info().time && (entry.info().time as Record<string, unknown>).created) || 0,
      }));
  const filtered = () => {
    const value = query().trim().toLowerCase();
    const rows = entries();
    if (!value) return rows;
    return rows.filter((entry) => entry.text.toLowerCase().includes(value));
  };
  const reveal = (id: string) => {
    props.conversation.focusMessage.set(id);
    props.close();
  };
  const time = (entry: TimelineEntry) => (entry.created > 0 ? formatTimeForLocale(entry.created, 'auto', currentLocale()) : '');
  const preview = (entry: TimelineEntry) => {
    const line = entry.text.replace(/\s+/g, ' ').trim();
    return line.length > 90 ? `${line.slice(0, 90)}…` : line || t('chat.timeline.noTextContent');
  };
  const height = () => Math.max(360, windowSize().height * 0.72);
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
      <View style={{ height: height(), paddingHorizontal: 14, paddingTop: 10, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 8 }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: '600', color: colors.foreground() }}>{t('chat.timeline.title')}</Text>
          <Button onPress={props.close} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} tone="muted" />
          </Button>
        </View>
        <Input
          testID="timeline-search"
          value={query()}
          onChange={(event) => query.set(event.value)}
          placeholder={t('chat.timeline.searchPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          style={field}
        />
        <Scroll class="flex-1" style={{ marginTop: 8 }} scrollbar={false} contentStyle={{ paddingBottom: 12 }}>
          <If
            when={filtered().length > 0}
            else={
              <EmptyState
                icon="history"
                title={query().trim() ? t('chat.timeline.empty.search') : t('chat.timeline.empty.session')}
              />
            }
          >
            <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.22) }}>
              <Each of={filtered()} key={(entry) => entry.id}>
                {(entry) => (
                  <Button
                    testID={`timeline-row-${entry().id}`}
                    onPress={() => reveal(entry().id)}
                    activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 }}
                  >
                    <Text style={{ width: 44, fontSize: 11, color: colors.mutedForeground() }}>{time(entry())}</Text>
                    <Text style={{ flexShrink: 1, fontSize: 13, color: colors.foreground(), numberOfLines: 2 }}>{preview(entry())}</Text>
                  </Button>
                )}
              </Each>
            </View>
          </If>
        </Scroll>
      </View>
    </Sheet>
  );
}
