import { cleanup, effect, keymap, lifecycle, platform, Scroll, signal, Text, untracked, View, type JSX, type ScrollRef, type ViewRef } from 'nsh';
import { Button, ContextMenu, MenuItem } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { desktopPanelScopeKey, type DesktopPanelScope, type DesktopPanelTab } from './desktop-panel-model';
import type { NativeDesktopPanelTabsOwner } from './desktop-panel';
import { createDesktopPanelTabDrag, createDesktopPanelTabsInteraction, desktopPanelTabPresentation, desktopPanelTabsKeymapAllowed, type DesktopPanelCloseAction } from './desktop-panel-tabs-core';
import { DesktopPanelTabNativeEvents } from './desktop-panel-tabs-events';
import { desktopTabHitRect, type DesktopTabHitRect } from './desktop-panel-tabs-events-core';

let nativeOwnerSerial = 0;

export type DesktopPanelTabsProps = {
  tabs: NativeDesktopPanelTabsOwner; scope: DesktopPanelScope; current: () => boolean; active: boolean;
  /** Optional integration/test port. The real Web strip has no bulk-close menu;
   * omit this prop for parity. No menu is constructed without explicit labels. */
  closeLabels?: Record<DesktopPanelCloseAction, string>;
  menuOwnedKeystrokes?: readonly string[];
  label?: (tab: DesktopPanelTab) => string;
  /** Existing Git/files rail actions, on this same header row; no second toolbar. */
  railActions?: JSX.Element;
  expanded?: boolean; onToggleExpanded?: () => void;
  /** Hide the workbench only. Never close tabs or discard editors here. */
  onClose?: () => void;
};
function label(tab: DesktopPanelTab) {
  if (tab.kind === 'file' || tab.kind === 'preview') return tab.path.split('/').pop() || tab.path;
  if (tab.kind === 'browser') return tab.url;
  if (tab.kind === 'context') return t('contextPanel.mode.context');
  if (tab.kind === 'chat') return tab.target.title?.trim() || t('contextPanel.mode.chat');
  if (tab.kind === 'btw') return t('chat.btw.title');
  return tab.source.path?.split('/').pop() || t(tab.source.kind === 'turn' ? 'diffView.scope.lastTurn' : 'contextPanel.mode.diff');
}
const generation = (scope: DesktopPanelScope) => JSON.stringify([desktopPanelScopeKey(scope), scope.host.lease]);

/** Window owner is injected, never constructed here. Scope/lease remount only tears
 * down transient pointer/menu/key owners; same-identity drafts and tabs stay untouched. */
export function DesktopPanelTabs(props: DesktopPanelTabsProps) {
  return <Each of={[generation(props.scope)]} key={key => key}>{() => <Strip {...props} />}</Each>;
}
function Strip(props: DesktopPanelTabsProps) {
  const scope: DesktopPanelScope = { ...props.scope, host: { ...props.scope.host } }, identity = generation(scope);
  const focused = signal(false), busy = signal(false), menu = signal<string | null>(null), scroll = signal<ScrollRef | null>(null);
  const dragState = signal<{ active: string | null; over: string | null }>({ active: null, over: null });
  const rows = new Map<string, ViewRef>(), targets = new Map<string, ViewRef>(), menuOwner = {};
  const hitGeometry = signal<{ revision: number; rects: ReadonlyMap<string, DesktopTabHitRect> }>({ revision: 1, rects: new Map() });
  let alive = true, offset = 0, revealSerial = 0, geometrySerial = 1, geometryQueued = false, geometryRunning = false;
  let nativeFocusedOwner: string | null = null;
  const current = () => alive && props.current() && props.active && lifecycle() === 'active' && generation(props.scope) === identity;
  const enabled = () => current() && !busy();
  const snapshot = () => props.tabs.snapshot(scope);
  const nativeEnabled = () => enabled() && !props.tabs.modalOpen();
  function requestGeometry() {
    const ticket = ++geometrySerial;
    if (hitGeometry().rects.size) hitGeometry.set({ revision: ticket, rects: new Map() });
    queueGeometry();
  }
  function queueGeometry() {
    if (geometryQueued || geometryRunning || !current() || dragState().active !== null) return;
    geometryQueued = true;
    void Promise.resolve().then(async () => {
      geometryQueued = false;
      const ticket = geometrySerial, node = scroll();
      if (!node || !current() || dragState().active !== null) return;
      geometryRunning = true;
      try {
        const view = await node.measure();
        if (!view || !current() || ticket !== geometrySerial) return;
        const viewport = { ...view.pagePosition, width: view.bounds.size.width, height: view.bounds.size.height };
        const entries = [...targets], rects = new Map<string, DesktopTabHitRect>();
        for (let index = 0; index < entries.length; index += 2) {
          if (!current() || ticket !== geometrySerial) return;
          const measured = await Promise.all(entries.slice(index, index + 2).map(async ([id, target]) => {
            const rect = await target.measure();
            return { id, rect: rect && desktopTabHitRect({ ...rect.pagePosition, width: rect.bounds.size.width, height: rect.bounds.size.height }, viewport) };
          }));
          for (const { id, rect } of measured) if (rect) rects.set(id, rect);
        }
        if (current() && ticket === geometrySerial) hitGeometry.set({ revision: ticket, rects });
      } catch { /* No valid native hit registration until a later real layout/scroll. */ }
      finally { geometryRunning = false; if (ticket !== geometrySerial) queueGeometry(); }
    });
  }
  const interaction = createDesktopPanelTabsInteraction({ tabs: props.tabs, scope: () => scope, current, busy: value => busy.set(value) });
  const drag = createDesktopPanelTabDrag({
    current: enabled, generation: () => identity, ids: () => snapshot().tabs.map(tab => tab.id),
    measure: async id => { const value = await rows.get(id)?.measure(); return value ? { ...value.pagePosition, width: value.bounds.size.width, height: value.bounds.size.height } : null; },
    changed: value => {
      const wasDragging = untracked(() => dragState().active !== null);
      dragState.set(value);
      if (wasDragging !== (value.active !== null)) requestGeometry();
    }, reorder: interaction.reorder,
  });
  function close(id: string, action: DesktopPanelCloseAction = 'close') { if (!enabled()) return; menu.set(null); drag.cancel(); void interaction.close(id, action); }
  function navigate(direction: 'previous' | 'next' | 'first' | 'last', reorder = false) {
    interaction.navigate(direction, reorder);
    const selected = snapshot().selectedID;
    if (enabled() && focused() && selected) targets.get(selected)?.focus();
  }
  async function reveal() {
    const ticket = ++revealSerial, node = scroll(), id = snapshot().selectedID;
    if (!enabled() || !node || !id) return;
    try {
      const [viewport, tab] = await Promise.all([node.measure(), rows.get(id)?.measure()]);
      if (!enabled() || ticket !== revealSerial || snapshot().selectedID !== id || !viewport || !tab) return;
      const left = tab.pagePosition.x - viewport.pagePosition.x, right = left + tab.bounds.size.width;
      const delta = left < 0 ? left : right > viewport.bounds.size.width ? right - viewport.bounds.size.width : 0;
      if (Math.abs(delta) > 0.5) node.scrollTo({ x: Math.max(0, offset + delta), animated: false });
    } catch { /* A detached row has no scroll authority. The native Scroll stays usable. */ }
  }
  effect(() => {
    const open = menu(), menusEnabled = props.closeLabels !== undefined;
    props.tabs.setModal(menuOwner, menusEnabled && open !== null && current());
    if (!menusEnabled) untracked(() => menu.set(null));
    if (!current()) untracked(() => { menu.set(null); focused.set(false); drag.cancel(); revealSerial++; });
  });
  effect(() => { if (!nativeEnabled()) untracked(() => { nativeFocusedOwner = null; focused.set(false); }); });
  effect(() => {
    snapshot().selectedID; snapshot().tabs; scroll(); const active = current();
    if (active) untracked(() => { void reveal(); });
    untracked(requestGeometry);
  });
  effect(() => {
    if (!enabled() || !focused() || menu() !== null) return;
    const owned = props.menuOwnedKeystrokes ?? [], apple = platform.os === 'macos' || platform.os === 'ios';
    const plan: Array<{ stroke: string; run: () => void; repeat?: boolean }> = [
      { stroke: 'left', run: () => navigate('previous'), repeat: true },
      { stroke: 'right', run: () => navigate('next'), repeat: true },
      { stroke: 'home', run: () => navigate('first') },
      { stroke: 'end', run: () => navigate('last') },
      { stroke: 'alt+shift+left', run: () => navigate('previous', true) },
      { stroke: 'alt+shift+right', run: () => navigate('next', true) },
      { stroke: 'mod+w', run: () => { const id = snapshot().selectedID; if (id) close(id); } },
    ];
    const bindings = plan.filter(binding => desktopPanelTabsKeymapAllowed(binding.stroke, owned, apple))
      .map(binding => keymap.bind(binding.stroke, binding.run, { when: 'notEditing', repeat: binding.repeat }));
    cleanup(() => bindings.forEach(remove => remove()));
  });
  cleanup(() => { alive = false; revealSerial++; geometrySerial++; interaction.dispose(); drag.cancel(); props.tabs.setModal(menuOwner, false); });
  function Row(item: { tab: DesktopPanelTab }) {
    const id = item.tab.id;
    let target: ViewRef | undefined;
    const title = () => (props.label ?? label)(item.tab);
    const presentation = () => desktopPanelTabPresentation(item.tab);
    const selected = () => snapshot().selectedID === id;
    cleanup(() => { rows.delete(id); targets.delete(id); });
    function Body() {
      const owner = `desktop-tab:${++nativeOwnerSerial}`, nativeGeneration = nativeOwnerSerial;
      let bodyTarget: ViewRef | undefined;
      cleanup(() => {
        if (targets.get(id) === bodyTarget) targets.delete(id);
        if (nativeFocusedOwner === owner) { nativeFocusedOwner = null; focused.set(false); }
      });
      const binding = () => ({ owner, generation: nativeGeneration, revision: hitGeometry().revision, expectedHost: scope.host,
        active: nativeEnabled() && hitGeometry().rects.has(id), rect: hitGeometry().rects.get(id) ?? { x: 0, y: 0, width: 1, height: 1 } });
      return <View ref={node => { rows.set(id, node); }} class={`flex-row items-center rounded-md ${selected() ? 'bg-accent' : 'hover:bg-secondary'} ${dragState().active === id ? 'opacity-50' : ''} ${dragState().over === id && dragState().active !== id ? 'border border-primary' : ''}`} style={{ flexShrink: 0, maxWidth: 240, height: 24 }}>
        <DesktopPanelTabNativeEvents binding={binding()} current={() => current() && snapshot().tabs.some(tab => tab.id === id)} enabled={nativeEnabled} modal={props.tabs.modalOpen}
          middle={() => { if (nativeEnabled()) { drag.cancel(); void interaction.pointerClose(id, 'middle'); } }}
          focus={() => { bodyTarget?.blur(); nativeFocusedOwner = owner; focused.set(true); }}
          blur={() => { if (nativeFocusedOwner === owner) { nativeFocusedOwner = null; focused.set(false); } }} />
        <View ref={node => { target = node; bodyTarget = node; targets.set(id, node); }} role="tab" testID={`desktop-panel-tab-${id}`} focusable disabled={!enabled()} accessibilityLabel={title()} accessibilityState={{ selected: selected() }} tooltip={<Text>{title()}</Text>}
          onLayout={requestGeometry}
          class="flex-row items-center gap-1 px-2 cursor-grab" style={{ minWidth: 60, maxWidth: 220, height: 24 }}
          onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
          onPressDown={event => { if (enabled()) drag.arm(id, event.pagePosition); }}
          onPanStart={() => drag.begin()} onPanEnd={event => { void drag.end(event.translation, event.cancelled); }}
          onPress={() => { drag.cancel(); if (interaction.select(id)) target?.focus(); }}>
          <Icon name={presentation().icon} size={14} />
          <Text class="text-xs text-foreground" style={{ flexShrink: 1, numberOfLines: 1 }}>{title()}</Text>
          <If when={item.tab.kind === 'file' && props.tabs.isDirty(scope, item.tab.path, item.tab.source)}><Text testID={`desktop-tab-dirty-${id}`} class="text-xs text-muted-foreground" accessibilityLabel={t('filesView.unsaved.title')}>●</Text></If>
          <If when={presentation().staged}><Text class="text-xs text-muted-foreground">{t('diffView.scope.staged')}</Text></If>
        </View>
        <Button testID={`desktop-panel-close-${id}`} class="rounded-md items-center justify-center hover:bg-secondary" style={{ width: 20, height: 24 }} disabled={!enabled()} accessibilityLabel={t('contextPanel.tab.closeTabAria', { label: title() })} onPress={() => close(id)}><Icon name="close" size={12} /></Button>
      </View>;
    }
    return <If when={props.closeLabels !== undefined} else={<Body />}><ContextMenu open={enabled() && menu() === id} onOpenChange={event => { drag.cancel(); menu.set(event.open && enabled() ? id : null); }}
      popupClass="min-w-48 p-1 bg-card rounded-lg border border-border" trigger={<Body />}>
      <Each of={['close', 'others', 'right', 'all'] as const}>{action => <MenuItem disabled={!enabled()} onSelect={() => close(id, action())}><Text class="text-sm text-foreground">{props.closeLabels?.[action()]}</Text></MenuItem>}</Each>
    </ContextMenu></If>;
  }
  return <View testID="desktop-panel-tabs" disabled={!enabled()} class="flex-row items-center min-w-0" style={{ height: 48, paddingLeft: 8, paddingRight: 12, gap: 6 }}
    onTouchCancelCapture={() => drag.cancel()} onMouseMove={event => { void drag.move(event.pagePosition, event.pressedButton); }} onMouseLeave={() => drag.cancel()}>
    <Scroll horizontal ref={node => scroll.set(node)} role="tablist" accessibilityLabel={t('sortableTabsStrip.aria.tabs')} class="flex-1 min-w-0" style={{ height: 24 }}
      onLayout={() => { drag.cancel(); requestGeometry(); void reveal(); }} onScroll={event => { if (offset !== event.offset.x) { offset = event.offset.x; drag.cancel(); requestGeometry(); } }}>
      <View class="flex-row items-center gap-1" style={{ height: 24 }}><Each of={snapshot().tabs} key={tab => tab.id}>{tab => <Row tab={tab()} />}</Each></View>
    </Scroll>
    <View class="flex-row items-center" style={{ flexShrink: 0, gap: 4 }}>
      {props.railActions}
      <If when={props.onToggleExpanded !== undefined}><Button testID="desktop-panel-toggle-expanded" class="items-center justify-center rounded-md hover:bg-secondary" style={{ width: 28, height: 28 }} disabled={!enabled()} accessibilityLabel={t(props.expanded ? 'contextPanel.actions.collapsePanel' : 'contextPanel.actions.expandPanel')} onPress={() => { if (enabled()) props.onToggleExpanded?.(); }}><Icon name={props.expanded ? 'collapse-diagonal' : 'expand-diagonal'} size={14} /></Button></If>
      <If when={props.onClose !== undefined}><Button testID="desktop-panel-close-panel" class="items-center justify-center rounded-md hover:bg-secondary" style={{ width: 28, height: 28 }} disabled={!enabled()} accessibilityLabel={t('contextPanel.actions.closePanel')} onPress={() => { if (enabled()) props.onClose?.(); }}><Icon name="close" size={14} /></Button></If>
    </View>
  </View>;
}
