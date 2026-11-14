import { PanResponder, Text, View, signal, type GestureResponderEvent } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, statusColor } from '../core/theme';
import { Icon } from '../core/Icon';
import { Highlighted, Spinner, alpha, fontSize } from '../core/ui';
import { liveStatus, pendingFor } from '../core/store';
import type { Node } from './model';
import type { SessionDrag } from './drag';

const RAIL_WIDTH = 104;
const RAIL_OPEN = 36;

/** Web `resolveMobileSessionIndicator`: one dot says what the session needs. */
type Indicator = 'question' | 'permission' | 'running' | 'completed-unread' | 'idle';

function indicatorFor(node: Node): Indicator {
  const status = liveStatus(node.id);
  const pending = pendingFor(node.id);
  if (pending.questions > 0) return 'question';
  if (pending.permissions > 0) return 'permission';
  if (status?.type === 'busy' || status?.type === 'retry') return 'running';
  if (node.unread) return 'completed-unread';
  return 'idle';
}

function StatusDot(props: { node: () => Node }) {
  const indicator = () => indicatorFor(props.node());
  const label = () =>
    indicator() === 'question'
      ? t('sessions.sidebar.session.status.questionRequired')
      : indicator() === 'permission'
        ? t('sessions.sidebar.session.status.permissionRequired')
        : indicator() === 'running'
          ? t('sessions.sidebar.session.status.active')
          : indicator() === 'completed-unread'
            ? t('sessions.sidebar.session.status.unread')
            : undefined;
  return (
    <View style={{ width: 12, height: 12, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={label()}>
      <If when={indicator() === 'running'}>
        <Spinner size={10} color={colors.mutedForeground()} />
      </If>
      <If when={indicator() === 'question'}>
        <Icon name="question" size={12} color={() => statusColor('warning')} />
      </If>
      <If when={indicator() === 'permission'}>
        <Icon name="shield" size={11} color={() => colors.destructive()} />
      </If>
      <If when={indicator() === 'completed-unread'}>
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: statusColor('info') }} />
      </If>
      <If when={indicator() === 'idle'}>
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: alpha(colors.mutedForeground(), 0.35) }} />
      </If>
    </View>
  );
}

/** “More” / “Fewer” — one pagination control under the rows it pages. */
export function PaginationRow(props: { node: () => Node; continues: () => boolean; onSelect: () => void }) {
  return (
    <View
      style={{
        minHeight: 40,
        ...(props.continues() ? {} : { borderTopWidth: 0.5, borderTopColor: colors.border() }),
      }}
    >
      <Button
        onPress={props.onSelect}
        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
        style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 36, paddingRight: 10, paddingVertical: 6 }}
      >
        <Text style={{ flex: 1, fontSize: fontSize.sessionTitle, color: colors.mutedForeground(), textAlign: 'left', numberOfLines: 1 }}>
          {props.node().title}
        </Text>
        <If when={!!props.node().subtitle}>
          <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground() }}>{props.node().subtitle ?? ''}</Text>
        </If>
        <Icon name="arrow-right-s" size={14} tone="muted" />
      </Button>
    </View>
  );
}

/** One Web `MobileSessionRow`: status dot, title, changes, subtitle, time, more, swipe rail. */
export function SessionRow(props: {
  node: () => Node;
  divider: () => boolean;
  highlight: () => string;
  onSelect: () => void;
  onPin: () => void;
  onArchive: () => void;
  onOpenActions: () => void;
  /** A long press opens the sheet where the row cannot be dragged (Web's TouchSensor owns it elsewhere). */
  actionsOnLongPress?: () => boolean;
  /** The pinned and in-progress surfaces keep their own ids for the same session. */
  idPrefix?: string;
  drag?: SessionDrag;
}) {
  const offset = signal(0);
  let start = 0;
  let swiped = false;
  const id = () => props.node().id;

  const pan = PanResponder.create({
    onMoveShouldSetPanResponder: (_, state) =>
      !props.drag?.claimed(id()) && Math.abs(state.dx) > 10 && Math.abs(state.dx) > Math.abs(state.dy),
    onPanResponderGrant: () => {
      start = offset();
      swiped = true;
    },
    onPanResponderMove: (_, state) => offset.set(Math.max(-RAIL_WIDTH, Math.min(0, start + state.dx))),
    onPanResponderRelease: () => offset.set(offset() < -RAIL_OPEN ? -RAIL_WIDTH : 0),
    onPanResponderTerminate: () => offset.set(start),
  });

  const closeRail = () => offset.set(0);
  const pinLabel = () =>
    props.node().pinned ? t('sessions.sidebar.session.menu.unpin') : t('sessions.sidebar.session.menu.pin');

  const select = () => {
    if (props.drag?.consumeClick(id())) {
      swiped = false;
      return;
    }
    if (swiped) {
      swiped = false;
      return;
    }
    if (offset() !== 0) {
      closeRail();
      return;
    }
    props.onSelect();
  };

  return (
    <View
      style={{
        overflow: 'hidden',
        ...(props.divider() ? { borderBottomWidth: 0.5, borderBottomColor: colors.border() } : {}),
      }}
    >
      <If when={offset() < 0}>
        <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: RAIL_WIDTH, flexDirection: 'row' }}>
          <Button
            onPress={() => {
              closeRail();
              props.onPin();
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: colors.muted() }}
          >
            <Icon name={() => (props.node().pinned ? 'unpin' : 'pushpin')} size={17} />
            <Text style={{ fontSize: fontSize.sessionMeta, color: colors.foreground(), numberOfLines: 1 }}>{pinLabel()}</Text>
          </Button>
          <Button
            onPress={() => {
              closeRail();
              props.onArchive();
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: alpha(colors.destructive(), 0.12) }}
          >
            <Icon name="archive" size={17} color={() => colors.destructive()} />
            <Text style={{ fontSize: fontSize.sessionMeta, color: colors.destructive(), numberOfLines: 1 }}>
              {t('sessions.sidebar.bulkActions.archive')}
            </Text>
          </Button>
        </View>
      </If>

      <View
        {...pan.panHandlers}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: 40,
          transform: [{ translateX: offset() }],
          opacity: props.node().archived ? 0.55 : 1,
        }}
      >
        <View
          style={{ flex: 1 }}
          onTouchStartCapture={(event: GestureResponderEvent) => props.drag?.start(id(), event)}
          onTouchMoveCapture={(event: GestureResponderEvent) => props.drag?.move(id(), event)}
          onTouchEndCapture={(event: GestureResponderEvent) => props.drag?.finish(id(), event)}
          onTouchCancelCapture={() => props.drag?.cancel()}
          onMoveShouldSetResponderCapture={() => props.drag?.claimed(id()) ?? false}
          onResponderGrant={() => props.drag?.claimed(id()) ?? false}
          onResponderMove={(event: GestureResponderEvent) => props.drag?.move(id(), event)}
          onResponderRelease={(event: GestureResponderEvent) => props.drag?.finish(id(), event)}
          onResponderTerminate={() => props.drag?.cancel()}
          onResponderTerminationRequest={() => !props.drag?.claimed(id())}
        >
          <View
            testID={`${props.idPrefix ?? ''}session-${id()}`}
            role="button"
            onPressDown={() => {
              if (!props.drag?.claimed(id())) swiped = false;
            }}
            onPress={select}
            onLongPress={() => {
              if (props.actionsOnLongPress?.() ?? false) props.onOpenActions();
            }}
            activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
            style={{
              minHeight: 40,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingLeft: 16,
              paddingRight: 2,
              paddingVertical: 5,
            }}
          >
            <StatusDot node={props.node} />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Highlighted
                  value={() => props.node().title}
                  query={props.highlight}
                  style={{
                    flexShrink: 1,
                    fontSize: fontSize.sessionTitle,
                    lineHeight: 16,
                    letterSpacing: -0.012,
                    fontWeight: props.node().unread ? '700' : '500',
                    color: colors.foreground(),
                    numberOfLines: 1,
                  }}
                />
                <If when={!!props.node().changes}>
                  <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                    {props.node().changes ?? ''}
                  </Text>
                </If>
                <If when={props.node().pinned}>
                  <Icon name="pushpin" size={10} tone="muted" />
                </If>
                <If when={props.node().archived}>
                  <Icon name="archive" size={12} tone="muted" />
                </If>
              </View>
              <If when={!!(props.node().subtitle || props.node().machine)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <If when={!!props.node().subtitle}>
                    <Highlighted
                      value={() => props.node().subtitle ?? ''}
                      query={props.highlight}
                      style={{
                        flexShrink: 1,
                        fontSize: fontSize.sessionMeta,
                        lineHeight: 12,
                        color: colors.mutedForeground(),
                        numberOfLines: 1,
                      }}
                    />
                  </If>
                  <If when={!!props.node().machine}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 }}>
                      <Icon name="computer" size={10} tone="muted" />
                      <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                        {props.node().machine ?? ''}
                      </Text>
                    </View>
                  </If>
                </View>
              </If>
            </View>
            <If when={!!props.node().activityLabel}>
              <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground() }}>
                {props.node().activityLabel ?? ''}
              </Text>
            </If>
          </View>
        </View>
        <Button
          testID={`${props.idPrefix ?? ''}session-menu-${id()}`}
          onPress={() => props.onOpenActions()}
          accessibilityLabel={t('sessions.sidebar.session.menu.label')}
          style={{ width: 36, height: 36, marginRight: 2, alignItems: 'center', justifyContent: 'center' }}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1), borderRadius: 12 }}
        >
          <Icon name="more-2" size={14} tone="muted" />
        </Button>
      </View>
    </View>
  );
}
