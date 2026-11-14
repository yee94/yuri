import { PanResponder, Text, View, signal } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon } from '../core/Icon';
import { Spinner, alpha, fontSize } from '../core/ui';
import { assistantPreviewText, assistantTitle, type Assistant } from './data';
import { AssistantAvatar, AssistantUnread } from './Avatar';

const RAIL_WIDTH = 132;
const RAIL_OPEN = 40;

/** Web `MobileAssistantCard`: avatar, name, last message, unread badge and a left swipe rail. */
export function AssistantCard(props: {
  assistant: () => Assistant;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const offset = signal(0);
  let start = 0;
  let swiped = false;
  const row = () => props.assistant();

  const pan = PanResponder.create({
    onMoveShouldSetPanResponder: (_, state) => Math.abs(state.dx) > 12 && Math.abs(state.dx) > Math.abs(state.dy),
    onPanResponderGrant: () => {
      start = offset();
      swiped = true;
    },
    onPanResponderMove: (_, state) => offset.set(Math.max(-RAIL_WIDTH, Math.min(0, start + state.dx))),
    onPanResponderRelease: () => offset.set(offset() < -RAIL_OPEN ? -RAIL_WIDTH : 0),
    onPanResponderTerminate: () => offset.set(start),
  });

  const close = () => offset.set(0);
  const select = () => {
    if (swiped) {
      swiped = false;
      return;
    }
    if (offset() !== 0) {
      close();
      return;
    }
    props.onOpen();
  };

  return (
    <View style={{ overflow: 'hidden', borderRadius: radius.surface }}>
      <If when={offset() < 0}>
        <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: RAIL_WIDTH, flexDirection: 'row' }}>
          <Button
            onPress={() => {
              close();
              props.onEdit();
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: colors.muted() }}
          >
            <Icon name="edit" size={17} />
            <Text style={{ fontSize: fontSize.sessionMeta, color: colors.foreground() }}>{t('assistants.menu.edit')}</Text>
          </Button>
          <Button
            onPress={() => {
              close();
              props.onDelete();
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: alpha(colors.destructive(), 0.12) }}
          >
            <Icon name="delete-bin" size={17} color={() => colors.destructive()} />
            <Text style={{ fontSize: fontSize.sessionMeta, color: colors.destructive() }}>{t('assistants.settings.delete')}</Text>
          </Button>
        </View>
      </If>

      <View
        {...pan.panHandlers}
        testID={`assistant-${row().id}`}
        role="button"
        onPressDown={() => {
          swiped = false;
        }}
        onPress={select}
        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          minHeight: 76,
          padding: 16,
          borderRadius: radius.surface,
          backgroundColor: alpha(colors.card(), 0.88),
          backdropFilter: 'blur(22px) saturate(1.35)',
          transform: [{ translateX: offset() }],
        }}
      >
        <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <AssistantAvatar seed={row().avatarSeed ?? row().id} size={44} label={assistantTitle(row())} />
          <If when={row().working}>
            <View style={{ position: 'absolute', right: -4, bottom: -4, backgroundColor: colors.background(), borderRadius: 7, padding: 1 }}>
              <Spinner size={12} />
            </View>
          </If>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ fontSize: 15, lineHeight: 24, fontWeight: '600', color: colors.foreground(), numberOfLines: 1 }}>
            {assistantTitle(row())}
          </Text>
          <Text style={{ fontSize: 12, color: colors.mutedForeground(), numberOfLines: 1 }}>
            {assistantPreviewText(row())}
          </Text>
        </View>
        <AssistantUnread count={row().unreadCount} />
      </View>
    </View>
  );
}
