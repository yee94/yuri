import { PanResponder, Text, View, signal } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors } from '../core/theme';
import { Icon } from '../core/Icon';
import { Surface, alpha, fontSize } from '../core/ui';
import { assistantPreviewText, assistantTitle, type Assistant } from './data';
import { AssistantUnread, AssistantWorkingAvatar } from './Avatar';

const RAIL_WIDTH = 112; // Web `--yuri-mobile-session-actions-width` outside a project shell
const RAIL_OPEN = 39; // Web snaps open past 35% of the rail

/** Web `MobileAssistantCard`: avatar, name, last message, unread badge and a left swipe rail. */
export function AssistantCard(props: {
  assistant: () => Assistant;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMenu: () => void;
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
    <Surface style={{ overflow: 'hidden', borderRadius: 24 }}>
      <If when={offset() < 0}>
        <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: RAIL_WIDTH, flexDirection: 'row' }}>
          <Button
            onPress={() => {
              close();
              props.onEdit();
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: colors.muted() }}
          >
            <Icon name="edit" size={18} />
            <Text style={{ fontSize: fontSize.sessionMeta, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}>
              {t('assistants.menu.edit')}
            </Text>
          </Button>
          <Button
            onPress={() => {
              close();
              props.onDelete();
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: alpha(colors.destructive(), 0.12) }}
          >
            <Icon name="delete-bin" size={18} color={() => colors.destructive()} />
            <Text style={{ fontSize: fontSize.sessionMeta, fontWeight: '500', color: colors.destructive(), numberOfLines: 1 }}>
              {t('assistants.settings.delete')}
            </Text>
          </Button>
        </View>
      </If>

      <View {...pan.panHandlers} style={{ transform: [{ translateX: offset() }] }}>
        <View
          testID={`assistant-${row().id}`}
          role="button"
          onPressDown={() => {
            swiped = false;
          }}
          onPress={select}
          onLongPress={() => {
            close();
            props.onMenu();
          }}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            minHeight: 76,
            padding: 16,
            borderRadius: 24,
          }}
        >
          <AssistantWorkingAvatar
            seed={row().avatarSeed ?? row().id}
            size={44}
            label={assistantTitle(row())}
            working={row().working}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={{
                fontSize: 15,
                lineHeight: 24,
                fontWeight: '600',
                letterSpacing: -0.3,
                color: colors.foreground(),
                numberOfLines: 1,
              }}
            >
              {assistantTitle(row())}
            </Text>
            <Text
              style={{
                marginTop: 4,
                fontSize: 12,
                lineHeight: 16,
                color: colors.mutedForeground(),
                numberOfLines: 1,
              }}
            >
              {assistantPreviewText(row())}
            </Text>
          </View>
          <AssistantUnread count={row().unreadCount} />
        </View>
      </View>
    </Surface>
  );
}
