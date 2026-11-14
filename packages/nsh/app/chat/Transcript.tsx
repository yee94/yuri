import { Scroll, Text, View, effect, signal, untracked, type ScrollRef } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors } from '../core/theme';
import { Icon } from '../core/Icon';
import { EmptyState, QuietButton, Spinner, alpha } from '../core/ui';
import { MessageRow } from './Parts';
import { BlockingCards } from './Blocking';
import { loadMessages, type Conversation } from './store';
import type { RowGroup } from './model';

function OlderHistory(props: { conversation: Conversation }) {
  const older = () => props.conversation.older();
  const more = () => props.conversation.more();
  const error = () => props.conversation.error();
  return (
    <View style={{ alignItems: 'center', paddingVertical: older() || more() ? 10 : 0 }}>
      <If when={older()}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Spinner size={12} />
          <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('chat.history.loadingMore')}</Text>
        </View>
      </If>
      <If when={!older() && more()}>
        <QuietButton label={() => t('chat.history.loadOlder')} onPress={() => void loadMessages(props.conversation, true)} />
      </If>
      <If when={!older() && !more() && !!error()}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 12, color: colors.destructive() }}>{t('chat.history.loadOlderFailed')}</Text>
          <Button onPress={() => void loadMessages(props.conversation, true)} style={{ paddingHorizontal: 8, paddingVertical: 2 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.foreground() }}>{t('chat.history.retry')}</Text>
          </Button>
        </View>
      </If>
    </View>
  );
}

function Blocking(props: { conversation: Conversation }) {
  return (
    <View style={{ paddingBottom: 4 }}>
      <BlockingCards conversation={props.conversation} />
    </View>
  );
}

function Empty(props: { conversation: Conversation }) {
  const failed = () => !!props.conversation.error() && !props.conversation.loading();
  return (
    <View style={{ minHeight: 300, alignItems: 'center', justifyContent: 'center', paddingVertical: 40 }}>
      <If
        when={failed()}
        else={
          <EmptyState
            icon="chat-thread"
            title={t('chat.emptyState.startNewChat')}
            description={props.conversation.directory()}
          />
        }
      >
        <View style={{ alignItems: 'center', gap: 10, paddingHorizontal: 24 }}>
          <Icon name="error-warning" size={24} color={() => colors.destructive()} />
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.foreground(), textAlign: 'center' }}>
            {t('chat.history.loadFailedTitle')}
          </Text>
          <Text style={{ fontSize: 13, color: colors.mutedForeground(), textAlign: 'center' }}>
            {t('chat.history.loadFailedDescription')}
          </Text>
          <QuietButton
            label={() => t('chat.history.retry')}
            onPress={() => void loadMessages(props.conversation)}
          />
        </View>
      </If>
    </View>
  );
}

/** The fully mounted transcript: every row has its native view, newest at the
 * bottom, older pages load at the top and the reading position stays put. */
export function Transcript(props: { conversation: Conversation }) {
  let scroller: ScrollRef | null = null;
  const rows = () => props.conversation.rows();

  // Content geometry, from the single inner content view's layout.
  const contentHeight = signal(0);
  const viewportHeight = signal(0);
  const offset = signal(0);
  // Anchor for a pending load-older: the offset and content height to restore
  // relative to, cleared once the compensated scroll landed.
  const anchor = signal<{ offset: number; height: number } | null>(null);
  // Until the reader first drags, the transcript stays pinned to the newest
  // end through every late layout (device content arrives in partial heights).
  let userTouched = false;
  // Row tops by key, for timeline / message focus jumps.
  const rowTops = signal<ReadonlyMap<string, number>>(new Map());
  const latestThreshold = 48;
  const loadMoreThreshold = 60;

  const key = () => props.conversation.key;
  const atLatest = () => {
    const content = contentHeight();
    const viewport = viewportHeight();
    if (!viewport || content <= viewport) return true;
    return content - viewport - offset() <= latestThreshold;
  };

  const rememberTop = (row: RowGroup, y: number) => {
    const next = new Map(rowTops());
    next.set(row.key, y);
    rowTops.set(next);
  };

  // Pin to the newest end: before the reader's first drag always, after it
  // only while they are still at the end. Subscribes to content growth only:
  // an offset-driven effect would fight an upward drag (the reader is still
  // within the latest threshold as a drag begins).
  let followedHeight = 0;
  effect(() => {
    const height = contentHeight();
    if (!height) return;
    const grew = height > followedHeight;
    followedHeight = height;
    if (!grew) return;
    if (!userTouched || untracked(atLatest)) scroller?.scrollTo({ y: height, animated: false });
  });

  // A load-older finished: rows appeared above, put the reader back.
  effect(() => {
    const held = anchor();
    const height = contentHeight();
    if (!held || !height || height === held.height) return;
    anchor.set(null);
    scroller?.scrollTo({ y: held.offset + (height - held.height), animated: false });
  });

  // Timeline / message focus: scroll the row into view.
  effect(() => {
    const id = props.conversation.focusMessage();
    if (!id) return;
    const target = rows().find((row) => row.ids.includes(id));
    const top = target ? rowTops().get(target.key) : undefined;
    if (top !== undefined) scroller?.scrollTo({ y: Math.max(0, top - viewportHeight() / 2), animated: true });
    props.conversation.focusMessage.set(null);
  });

  let wasAboveThreshold = false;
  const loadOlder = () => {
    const conversation = props.conversation;
    if (conversation.older() || !conversation.more()) return;
    if (!userTouched) return;
    // Edge-triggered only: the programmatic open-at-bottom scroll passes
    // through the top threshold without the reader asking for history.
    if (!wasAboveThreshold) return;
    wasAboveThreshold = false;
    if (!anchor()) anchor.set({ offset: offset(), height: contentHeight() });
    void loadMessages(conversation, true);
  };

  return (
    <View style={{ flex: 1, position: 'relative' }}>
      <Scroll
        testID="chat-transcript"
        style={{ flex: 1 }}
        ref={(node) => {
          scroller = node;
        }}
        onLayout={(event) => viewportHeight.set(event.bounds.size.height)}
        onScrollDragStart={() => {
          userTouched = true;
        }}
        onScroll={(event) => {
          const y = event.offset.y;
          if (y > loadMoreThreshold + 24) wasAboveThreshold = true;
          offset.set(y);
          if (y <= loadMoreThreshold) loadOlder();
        }}
      >
        <View
          style={{ minHeight: '100%', paddingVertical: 8 }}
          onLayout={(event) => contentHeight.set(event.bounds.size.height)}
        >
          <OlderHistory conversation={props.conversation} />
          <Blocking conversation={props.conversation} />
          <If when={rows().length === 0}>
            <Empty conversation={props.conversation} />
          </If>
          <Each of={rows()} key={(row) => row.key}>
            {(row) => (
              <View onLayout={(event) => rememberTop(row(), event.bounds.origin.y)}>
                <MessageRow conversation={props.conversation} row={row} />
              </View>
            )}
          </Each>
        </View>
      </Scroll>
      <If when={!atLatest()}>
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 10, alignItems: 'center' }}>
          <Button
            testID="chat-scroll-latest"
            accessibilityLabel={t('chat.scrollToBottom.aria')}
            onPress={() => scroller?.scrollTo({ y: contentHeight(), animated: true })}
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: alpha(colors.card(), 0.92),
              backdropFilter: 'blur(18px) saturate(1.3)',
              glassEffect: 'regular',
              boxShadow: '0 6px 18px -6px rgba(0,0,0,0.24)',
            }}
          >
            <Icon name="arrow-down" size={16} />
          </Button>
        </View>
      </If>
    </View>
  );
}
