import { cleanup, colorScheme, computed, createMotion, effect, keymap, lifecycle, List, Overlay, reduceMotion, signal, Text, token, untracked, View, windowSize, type ListRef, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import type { ChatTarget } from './model';
import { createSelectKeyboard } from './select-keyboard';
import { nativeAppearance, nativeChatTextStyle } from './appearance';
import { createDesktopSwitcherOwner, desktopSwitcherCatalog, desktopSwitcherDate, desktopSwitcherKey, desktopSwitcherRows, type DesktopSwitcherSource } from './desktop-session-switcher-core';

export type NativeDesktopSessionSwitcherProps = {
  open: boolean;
  /** The real desktop title button, not a WebView or a navigation-slot rectangle. */
  anchor: ViewRef | null;
  /** Host+authorization+generation/presentation identity, captured on open. */
  scope: unknown;
  /** Captured Host/authorization fence, independent of the popup's open bit. */
  current: () => boolean;
  active: boolean;
  currentTarget?: ChatTarget;
  source: DesktopSwitcherSource;
  scopeProjectId?: string | null;
  variant?: 'default' | 'compact';
  /** The parent must close this exact captured scope, not its latest popup. */
  onClose: (scope: unknown) => void;
  onOpenChat: (target: ChatTarget) => void;
  /** Open the existing local unsent draft; never create a remote session here. */
  onNewSession: () => void;
  /** Optional shell IME admission while focus transfers out of an existing editor. */
  composing?: boolean;
};

/** Hidden picker creates neither a catalog projection nor keyboard bindings. */
export function NativeDesktopSessionSwitcher(props: NativeDesktopSessionSwitcherProps) {
  effect(() => {
    if (props.open && (!props.active || !props.current() || lifecycle() !== 'active')) {
      const scope = props.scope; untracked(() => props.onClose(scope));
    }
  });
  return <If when={props.open && !!props.anchor && props.active && props.current() && lifecycle() === 'active'}>
    <Each of={[props.scope]}>{() => <DesktopSessionSwitcherPopup {...props} />}</Each>
  </If>;
}

function DesktopSessionSwitcherPopup(props: NativeDesktopSessionSwitcherProps) {
  const scope = props.scope, anchor = props.anchor, source = props.source;
  const onClose = untracked(() => props.onClose), openChat = untracked(() => props.onOpenChat), newSession = untracked(() => props.onNewSession);
  const expanded = signal<ReadonlySet<string>>(new Set());
  const highlighted = signal<string | null>(null), retry = signal({ retrying: false, error: '' });
  const available = signal<number | null>(null);
  const newHeight = signal(14 * 1.25 + 12), loadingHeight = signal(0), errorHeight = signal(0), emptyHeight = signal(0);
  let list: ListRef | undefined;
  let menu: ViewRef | undefined, focusRequested = false;
  const owner = createDesktopSwitcherOwner({ owns: () => props.open && props.scope === scope && props.anchor === anchor && props.source === source,
    current: () => props.current() && props.active && lifecycle() === 'active', currentTarget: () => props.currentTarget,
    navigationCurrent: () => props.scope === scope && props.source === source && props.current(),
    close: () => onClose(scope), openChat, newSession, changed: state => retry.set(state),
  });
  cleanup(owner.dispose);
  const snapshot = computed(() => source.snapshot());
  const catalog = computed(() => desktopSwitcherCatalog(snapshot(), props.scopeProjectId));
  const rows = computed(() => desktopSwitcherRows(catalog(), expanded()));
  const choices = computed(() => [{ value: '__new__', title: t('sessions.sidebar.header.actions.newSession') }, ...rows().map(row => ({ value: row.node.key, title: row.node.session.title }))]);
  function choose(value: string) {
    if (props.composing || !owner.current()) return;
    if (value === '__new__') owner.newSession();
    else {
      const row = rows().find(row => row.node.key === value);
      if (row) {
        const same = props.currentTarget?.kind === 'session' && desktopSwitcherKey(props.currentTarget) === row.node.key;
        owner.select(row.node.session);
        if (same && props.scope === scope && props.current()) anchor?.focus();
      }
    }
  }
  let scrollFocus = true;
  const makeKeyboard = (selected?: string) => createSelectKeyboard({ items: choices,
    selected: () => selected ?? '__new__', choose,
    focus: (value, index) => { highlighted.set(value); if (scrollFocus && index > 0) list?.scrollToIndex({ index: index - 1, animated: false, viewPosition: .5 }); },
  });
  let keyboard = makeKeyboard();
  const hover = (key: string) => {
    if (!owner.current() || highlighted() === key) return;
    scrollFocus = false; keyboard = makeKeyboard(key); keyboard.sync(); scrollFocus = true;
  };
  const toggle = (key: string) => { if (!owner.current()) return; const next = new Set(expanded()); if (next.has(key)) next.delete(key); else next.add(key); expanded.set(next); };
  effect(() => { choices(); untracked(() => keyboard.sync()); });
  effect(() => {
    if (!props.active || !props.current() || props.composing || lifecycle() !== 'active') return;
    const bindings: Record<string, () => void> = { up: () => keyboard.move('up'), down: () => keyboard.move('down'), enter: () => keyboard.choose(),
      home: () => keyboard.move('home'), end: () => keyboard.move('end'), pageup: () => keyboard.move('pageup'), pagedown: () => keyboard.move('pagedown'), space: () => keyboard.choose(),
      left: () => { const key = highlighted(); if (key && expanded().has(key)) toggle(key); },
      right: () => { const key = highlighted(); if (key && !expanded().has(key) && rows().some(row => row.node.key === key && row.node.children.length)) toggle(key); },
    };
    for (const letter of 'abcdefghijklmnopqrstuvwxyz0123456789') bindings[letter] = () => keyboard.type(letter);
    cleanup(keymap.bind(bindings, { when: 'notEditing', repeat: true }));
  });
  const height = () => Math.max(0, Math.min(windowSize().height * .6, (available() ?? Infinity) - 10));
  const error = () => retry().error || snapshot().error;
  const label = (timestamp: number) => { const date = desktopSwitcherDate(timestamp); return t(date.key, { count: date.count }); };
  const colors = () => nativeAppearance.current()?.webTheme?.[colorScheme()].colors;
  const hoverColor = () => colors()?.interactive.hover ?? token('accent');
  const selected = (key: string) => props.currentTarget?.kind === 'session' && desktopSwitcherKey(props.currentTarget) === key;
  const metadataStyle = () => ({ fontSize: (nativeChatTextStyle('uiLabel').fontSize ?? 14) * .85, lineHeight: (nativeChatTextStyle('uiLabel').fontSize ?? 14) * .85 * 1.25, opacity: .7 });
  const loading = () => snapshot().loading || retry().retrying || !snapshot().ready && !error();
  const rowHeight = () => 14 * 1.25 + 12 + (props.variant === 'compact' ? 0 : 2 + metadataStyle().lineHeight);
  const empty = () => snapshot().ready && !snapshot().loading && !error() && !rows().length;
  const contentHeight = () => newHeight() + (loading() ? loadingHeight() : 0) + (error() ? errorHeight() : 0)
    + (loading() ? 2 : 0) + (error() ? 2 : 0) + (empty() ? emptyHeight() + 2 : 0) + rows().length * (rowHeight() + 2);
  // Overlay owns native placement/flipping and follows the actual title ref.
  // Web: start aligned, 6px gap, 360/280px wide, viewport minus 32px, 60vh list.
  return <Overlay testID="desktop-session-switcher" anchor={anchor} placement="bottom" align="start" offset={6} margin={16}
    onPosition={event => {
      if (available() !== event.available.height) available.set(event.available.height);
      if (!focusRequested && menu && owner.current()) { focusRequested = true; menu.focus(); }
    }}
    onPressOutside={owner.close} onCancel={props.composing ? undefined : () => { if (owner.close() && props.scope === scope && props.current()) anchor?.focus(); }}
    class="bg-card border border-border rounded-xl p-1 shadow-lg overflow-hidden"
    style={{ width: Math.max(0, Math.min(props.variant === 'compact' ? 280 : 360, windowSize().width - 32)), maxHeight: height() + 10 }}>
    <View ref={node => { menu = node; }} role="menu" focusable accessibilityLabel={t('sessions.switcher.openAria')} style={{ maxHeight: height(), flexShrink: 1 }}>
      <List testID="desktop-switcher-list" ref={node => { list = node; }} each={rows()} keyExtractor={row => row.node.key}
        style={{ height: Math.min(contentHeight(), height()), flexShrink: 1 }} keyboardDismissMode="none"
        separator={<View style={{ height: 2 }} />} header={<View class="gap-0.5" style={{ paddingBottom: rows().length || empty() ? 2 : 0 }}>
      <View onMouseEnter={() => hover('__new__')}><Button testID="desktop-switcher-new" role="menuitem" class="flex-row items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent"
        onLayout={event => newHeight.set(event.bounds.size.height)}
        hoverStyle={{ backgroundColor: hoverColor() }} style={highlighted() === '__new__' ? { backgroundColor: hoverColor() } : undefined} onPress={() => choose('__new__')}>
        <Icon name="chat-new" size={16} /><Text class="text-foreground" style={{ fontSize: 14, lineHeight: 17.5 }}>{t('sessions.sidebar.header.actions.newSession')}</Text>
      </Button></View>
      <If when={loading()}><Text testID="desktop-switcher-loading" onLayout={event => loadingHeight.set(event.bounds.size.height)} class="px-2 py-1 text-xs text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!!error()}><View class="px-2 py-1 gap-1" onLayout={event => errorHeight.set(event.bounds.size.height)}><Text testID="desktop-switcher-error" class="text-xs text-destructive">{error()}</Text>
        <If when={!!source.retry}><Button testID="desktop-switcher-retry" disabled={snapshot().loading || retry().retrying} class="bg-secondary rounded-lg px-2 py-1.5" onPress={() => { void owner.retry(source.retry); }}><Text class="text-foreground text-xs">{t('chat.history.retry')}</Text></Button></If>
      </View></If>
      </View>}
        footer={<If when={empty()}><Text testID="desktop-switcher-empty" onLayout={event => emptyHeight.set(event.bounds.size.height)} class="px-3 py-4 text-xs text-muted-foreground text-center">{t('sessions.switcher.empty')}</Text></If>}>
        {entry => <View class="flex-row items-center gap-2 rounded-lg hover:bg-accent" hoverStyle={{ backgroundColor: hoverColor() }} onMouseEnter={() => hover(entry().node.key)}
          style={[{ paddingLeft: 8 + entry().depth * 12, paddingRight: 8, paddingTop: 6, paddingBottom: 6 }, highlighted() === entry().node.key ? { backgroundColor: hoverColor() } : null]}>
          <View class="flex-1 min-w-0 gap-0.5" role="menuitem" accessibilityState={{ selected: selected(entry().node.key) }}
            testID={`desktop-switcher-session-${entry().node.session.id}`} accessibilityLabel={entry().node.session.title.trim() || t('sessions.sidebar.session.untitled')}
            onPress={() => choose(entry().node.key)}>
            <View class="flex-row items-center gap-1.5">
              <If when={props.variant === 'compact' && !!entry().node.children.length}><SwitcherExpand sessionID={entry().node.session.id} expanded={expanded().has(entry().node.key)} onPress={() => toggle(entry().node.key)} /></If>
              <Text class="flex-1 text-foreground line-clamp-1" style={{ fontSize: 14, lineHeight: 17.5, color: selected(entry().node.key) ? colors()?.primary.base ?? token('ring') : token('foreground') }}>{entry().node.session.title.trim() || t('sessions.sidebar.session.untitled')}</Text>
              <If when={!!entry().node.session.changes}><Text class="text-xs text-muted-foreground">{entry().node.session.changes}</Text></If>
            </View>
            <If when={props.variant !== 'compact'}><View class="flex-row items-center gap-1.5">
              <If when={!!entry().node.children.length}><SwitcherExpand sessionID={entry().node.session.id} expanded={expanded().has(entry().node.key)} onPress={() => toggle(entry().node.key)} /></If>
              <Text class="text-muted-foreground" style={metadataStyle()}>{label(entry().node.session.updated || entry().node.session.created || Date.now())}</Text>
              <If when={!!entry().node.projectLabel}><Text class="text-muted-foreground line-clamp-1" style={metadataStyle()}>{entry().node.projectLabel}</Text></If>
              <If when={!!entry().node.branchLabel}><Icon name="git-branch" size={12} /><Text class="flex-1 text-muted-foreground line-clamp-1" style={metadataStyle()}>{entry().node.branchLabel}</Text></If>
            </View></If>
          </View>
          <If when={!!source.status?.(entry().node.session)}><SwitcherStatusDot running={source.status?.(entry().node.session) === 'running'}
            color={source.status?.(entry().node.session) === 'running' ? colors()?.primary.base ?? token('ring') : colors()?.status.info ?? token('ring')} /></If>
        </View>}
      </List>
    </View>
  </Overlay>;
}

function SwitcherExpand(props: { sessionID: string; expanded: boolean; onPress: () => void }) {
  return <Button testID={`desktop-switcher-expand-${props.sessionID}`} class="items-center justify-center" style={{ width: 14, height: 14 }}
    accessibilityLabel={props.expanded ? t('sessions.sidebar.session.subsessions.collapse') : t('sessions.sidebar.session.subsessions.expand')}
    selected={props.expanded} onPress={props.onPress}><Icon name={props.expanded ? 'arrow-down-s' : 'arrow-right-s'} size={12} /></Button>;
}

function SwitcherStatusDot(props: { running: boolean; color: string }) {
  const motion = createMotion();
  effect(() => {
    if (!props.running || lifecycle() !== 'active' || reduceMotion()) return;
    // index.css yuri-busy-pulse: 0.2 -> 1 -> 0.2 in 1.2s.
    void motion.play({ keyframes: { opacity: [.2, 1, .2] }, duration: 1200, easing: 'easeInOut', iterations: 'infinite' });
    cleanup(motion.reset);
  });
  cleanup(motion.stop);
  return <View accessibilityLabel={props.running ? t('sessions.sidebar.session.status.active') : t('sessions.sidebar.session.status.unread')}
    class="rounded-full" style={[{ width: 6, height: 6, backgroundColor: props.color }, motion.style]} />;
}
