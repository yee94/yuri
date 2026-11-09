import { cleanup, colorScheme, computed, effect, keymap, lifecycle, platform, Scroll, token, Text, untracked, View, windowSize, type ViewRef } from 'nsh';
import { Dialog } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { desktopHelpCatalog, desktopHelpGeometry, desktopHelpKeycaps, type DesktopHelpRow } from './desktop-help-core';
import type { NativeShortcutActions, ShortcutOverrides } from './desktop-shortcuts-core';

export type NativeDesktopHelpDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Stable Host/window/route authority, captured by this presentation. */
  scope: unknown;
  active?: boolean;
  userOverrides: ShortcutOverrides;
  /** Implementation support, not temporary modal admission. Omission is safely unavailable. */
  actions?: NativeShortcutActions;
};

/** Mount once under the desktop root. Closed help reads no catalog/overrides/actions.
 * The stable child is constructed under its mount owner, not inside a rerunning effect. */
export function NativeDesktopHelpDialog(props: NativeDesktopHelpDialogProps) {
  effect(() => {
    if (props.open && (props.active === false || lifecycle() !== 'active')) untracked(props.onClose);
  });
  return <If when={props.open && props.active !== false && lifecycle() === 'active'}>{() => untracked(() => <DesktopHelpPresentation {...props} />)}</If>;
}

function DesktopHelpPresentation(props: NativeDesktopHelpDialogProps) {
  const scope = untracked(() => props.scope);
  let alive = true, closed = false, content: ViewRef | undefined;
  const current = () => alive && !closed && props.open && props.active !== false && lifecycle() === 'active' && props.scope === scope;
  const close = () => { if (alive && !closed) { closed = true; props.onClose(); } };
  cleanup(() => { alive = false; });
  effect(() => { if (props.scope !== scope) untracked(close); });
  effect(() => {
    if (!current()) return;
    // A handled NSH keymap event is consumed before the focused composer's defaults.
    cleanup(keymap.bind('escape', () => untracked(close), { when: 'always' }));
  });
  const catalog = computed(() => desktopHelpCatalog(props.actions ?? {}, props.userOverrides, platform.os === 'macos' || platform.os === 'ios', stroke => keymap.label(stroke)));
  const geometry = () => desktopHelpGeometry(windowSize().width, windowSize().height);
  const dark = () => colorScheme() === 'dark';
  return <Dialog testID="desktop-help-dialog" open={current()} animation="fade" closeOnEscape={false} closeOnBackdropPress
    backdropClass="bg-transparent" backdropTestID="desktop-help-backdrop" class="rounded-3xl overflow-hidden"
    style={{ position: 'absolute', alignSelf: 'center', ...geometry(), backdropFilter: `blur(20px) saturate(${dark() ? 1.2 : 1.25})`,
      boxShadow: dark() ? '0 0 0 1px rgb(0 0 0 / 0.2), 0 8px 24px -4px rgb(0 0 0 / 0.4), 0 20px 48px -12px rgb(0 0 0 / 0.45), inset 0 1px 0 rgb(255 255 255 / 0.08)'
        : '0 0 0 1px rgb(0 0 0 / 0.04), 0 8px 24px -4px rgb(0 0 0 / 0.16), 0 20px 48px -12px rgb(0 0 0 / 0.18), inset 0 1px 0 rgb(255 255 255 / 0.8)' }}
    onOpen={() => { if (current()) content?.focus(); }} onCancel={close} onOpenChange={event => { if (!event.open) close(); }}>
    <View class="absolute inset-0 bg-card" style={{ opacity: .22 }} />
    <View testID="desktop-help-content" ref={ref => { content = ref; }} focusable role="region" accessibilityLabel={t('helpDialog.title')} class="flex-1 min-h-0">
      <View class="shrink-0 px-6 pt-4 pb-2"><Text testID="desktop-help-title" class="text-foreground" style={{ fontSize: 13, lineHeight: 20, fontWeight: '500' }}>{t('helpDialog.title')}</Text></View>
      <Scroll testID="desktop-help-scroll" class="flex-1 min-h-0" contentClass="px-2 pt-1 pb-3">
        <Each of={catalog()}>{(section, index) => <View testID={`desktop-help-section-${section().categoryKey}`} style={{ marginTop: index() ? 12 : 0 }}>
          <Text class="px-4 pb-1 text-muted-foreground" style={{ fontSize: 11, lineHeight: 17 }}>{t(section().categoryKey)}</Text>
          <Each of={section().items}>{(row, index) => <DesktopHelpShortcutRow row={row()} separated={index() > 0} />}</Each>
        </View>}</Each>
      </Scroll>
    </View>
  </Dialog>;
}

function DesktopHelpShortcutRow(props: { row: DesktopHelpRow; separated: boolean }) {
  const id = () => props.row.id ?? props.row.descriptionKey;
  return <View testID={`desktop-help-row-${id()}`} class="flex-row items-center gap-4 rounded-lg px-4 py-2" style={{ minHeight: 36, marginTop: props.separated ? 2 : 0 }} accessibilityState={{ disabled: !props.row.supported }}>
    <View class="flex-1 min-w-0 flex-row items-center gap-2">
      <If when={!!props.row.icon}><Icon name={props.row.icon!} size={14} color={token('muted-foreground')} /></If>
      <Text class="flex-1 min-w-0 text-foreground" style={{ fontSize: 13, lineHeight: 20 }}>{t(props.row.descriptionKey)}</Text>
    </View>
    <View class="min-w-0 flex-row flex-wrap items-center justify-end gap-1" style={{ width: '45%' }}>
      <If when={!props.row.supported}><Text testID={`desktop-help-unavailable-${id()}`} class="text-muted-foreground" style={{ fontSize: 11, lineHeight: 17 }}>{t('common.unavailable')}</Text></If>
      <Each of={props.row.displayKeys}>{(label, index) => <>
        <If when={index() > 0}><Text class="mx-1 text-muted-foreground" style={{ fontSize: 11, lineHeight: 17 }}>{t('helpDialog.keyCombiner.or')}</Text></If>
        <DesktopHelpHint label={label()} />
      </>}</Each>
    </View>
  </View>;
}

const keyIcons = { '⌘': 'command', '↵': 'corner-down-left', '↑': 'arrow-up', '↓': 'arrow-down', '←': 'arrow-left', '→': 'arrow-right', '⇧': 'arrow-up', Shift: 'arrow-up', Enter: 'corner-down-left' } as const;
function DesktopHelpHint(props: { label: string }) {
  return <View accessibilityLabel={props.label} class="flex-row items-center gap-1">
    <Each of={desktopHelpKeycaps(props.label)}>{key => <If when={key().separator} else={<View class="relative rounded-full items-center justify-center px-1.5" style={{ height: 14 }} accessibilityLabel={key().text}>
      <View class="absolute inset-0 rounded-full bg-foreground" style={{ opacity: .06 }} />
      <If when={key().text in keyIcons} else={<Text class="text-muted-foreground" style={{ fontSize: 10, fontWeight: '500', opacity: .65 }}>{key().text}</Text>}>
        <Icon name={keyIcons[key().text as keyof typeof keyIcons]} size={10} color={token('muted-foreground')} />
      </If>
    </View>}><Text class="text-muted-foreground" style={{ fontSize: 10, opacity: .65 }}>{key().text}</Text></If>}</Each>
  </View>;
}
