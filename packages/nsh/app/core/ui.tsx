import { Text, View, cleanup, computed, effect, platform, signal } from 'nsh';
import { AlertDialog, Button, Dialog, Sheet, type SheetProps } from 'nsh/base';
import { Icon, type IconName } from './Icon';
import { t } from './i18n';
import { colors, radius } from './theme';
import type { JSX, StyleProp, TextStyle, ViewStyle } from 'nsh';

/** `#rrggbbaa` from a theme color and an opacity, as Web's `color-mix` / alpha helpers. */
export function alpha(color: string, opacity: number): string {
  const value = color.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) return `#${hex}${Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0')}`;
  return value;
}

/** `.yuri-mobile-floating-surface`: frosted content card, no border. */
export function Surface(props: { children?: JSX.Element; class?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      class={props.class}
      style={[
        {
          backgroundColor: alpha(colors.card(), 0.88),
          borderRadius: radius.surface,
          backdropFilter: 'blur(22px) saturate(1.35)',
          boxShadow: '0 0 0 0.5px rgba(0,0,0,0.04), 0 8px 24px -8px rgba(0,0,0,0.12)',
        },
        props.style ?? null,
      ]}
    >
      {props.children}
    </View>
  );
}

export function Divider(props: { inset?: number }) {
  return <View style={{ height: 0.5, backgroundColor: colors.border(), marginLeft: props.inset ?? 0 }} />;
}

/** Web `.yuri-mobile-session-title` sizes. */
export const fontSize = {
  rootTitle: 32,
  entityTitle: 14,
  entityMeta: 12,
  sessionTitle: 12,
  sessionMeta: 10,
  /** Web `.yuri-mobile-group-label-trigger` overrides inside a project shell. */
  sessionGroupTitle: 12,
  sessionGroupMeta: 11,
  label: 16,
  body: 14,
};

export function Spinner(props: { size?: number; color?: string }) {
  const size = props.size ?? 14;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.5,
        borderColor: props.color ?? colors.mutedForeground(),
        borderTopColor: 'transparent',
        animationName: 'spin',
        animationDuration: 900,
        animationIterationCount: 'infinite',
      }}
    />
  );
}

/** The neutral solid primary action (Yuri's default action button); its text follows `label`. */
export function PrimaryButton(props: {
  label: () => string;
  onPress: () => void;
  disabled?: () => boolean;
  busy?: () => boolean;
  icon?: IconName;
  class?: string;
}) {
  return (
    <Button
      disabled={props.disabled?.() ?? false}
      onPress={props.onPress}
      class={props.class}
      style={{ minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={{
          minHeight: 44,
          paddingHorizontal: 18,
          borderRadius: 22,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          backgroundColor: colors.foreground(),
          opacity: props.disabled?.() ? 0.45 : 1,
          paddingVertical: 12,
        }}
      >
        <If when={!!props.busy?.()}>
          <Spinner size={14} color={colors.background()} />
        </If>
        <If when={!!props.icon && !props.busy?.()}>
          <Icon name={props.icon ?? 'add'} size={16} color={() => colors.background()} />
        </If>
        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.background() }}>{props.label()}</Text>
      </View>
    </Button>
  );
}

export function QuietButton(props: {
  label: () => string;
  onPress: () => void;
  disabled?: () => boolean;
  busy?: () => boolean;
  class?: string;
}) {
  return (
    <Button
      disabled={props.disabled?.() ?? false}
      onPress={props.onPress}
      class={props.class}
      style={{ minHeight: 44, borderRadius: radius.action, alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={{
          minHeight: 44,
          paddingHorizontal: 14,
          borderRadius: radius.action,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          backgroundColor: alpha(colors.muted(), 0.9),
          opacity: props.disabled?.() ? 0.45 : 1,
          paddingVertical: 10,
        }}
      >
        <If when={!!props.busy?.()}>
          <Spinner size={13} />
        </If>
        <Text style={{ fontSize: 15, fontWeight: '500', color: colors.foreground() }}>{props.label()}</Text>
      </View>
    </Button>
  );
}

/** One row of an action sheet (Web `MobileRowActionsSheet`'s `ActionRow`). */
export function ActionRow(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  divider?: boolean;
  spinning?: boolean;
  testID?: string;
}) {
  return (
    <Button
      testID={props.testID}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        minHeight: 56,
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        opacity: props.disabled ? 0.4 : 1,
        ...(props.divider ? { borderTopWidth: 0.5, borderTopColor: colors.border() } : {}),
      }}
      activeStyle={{ backgroundColor: colors.accent() }}
    >
      {props.spinning ? (
        <Spinner size={16} color={props.destructive ? colors.destructive() : colors.foreground()} />
      ) : (
        <Icon name={props.icon} size={18} color={() => (props.destructive ? colors.destructive() : colors.foreground())} />
      )}
      <Text
        style={{
          flexShrink: 1,
          fontSize: 16,
          color: props.destructive ? colors.destructive() : colors.foreground(),
        }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

/** Web `.yuri-mobile-empty`: one icon, a title and a line of help. */
export function EmptyState(props: {
  icon: IconName;
  title?: string;
  description?: string;
  action?: { label: string; icon?: IconName; onPress: () => void };
}) {
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32, gap: 8 }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.muted(),
          marginBottom: 4,
        }}
      >
        <Icon name={props.icon} size={24} tone="muted" />
      </View>
      {props.title ? (
        <Text style={{ fontSize: 16, fontWeight: '600', color: colors.foreground(), textAlign: 'center' }}>{props.title}</Text>
      ) : null}
      {props.description ? (
        <Text style={{ fontSize: 13, lineHeight: 18, color: colors.mutedForeground(), textAlign: 'center' }}>
          {props.description}
        </Text>
      ) : null}
      {props.action ? (
        <View style={{ marginTop: 8 }}>
          <PrimaryButton label={() => props.action!.label} icon={props.action.icon} onPress={props.action.onPress} />
        </View>
      ) : null}
    </View>
  );
}

export async function confirm(options: {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
}): Promise<boolean> {
  const answer = await AlertDialog.show({
    title: options.title,
    description: options.message ?? null,
    actions: [
      { id: 'cancel', label: options.cancelLabel, role: 'cancel' },
      { id: 'confirm', label: options.confirmLabel, role: options.destructive ? 'destructive' : 'default' },
    ],
  });
  return answer.action === 'confirm';
}

/** Simple list menu in the system's action sheet presentation. */
export async function actionMenu(options: {
  title?: string;
  actions: { id: string; label: string; destructive?: boolean }[];
}): Promise<string | null> {
  const answer = await AlertDialog.show({
    title: options.title ?? null,
    presentation: 'actionSheet',
    actions: options.actions.map((action) => ({
      id: action.id,
      label: action.label,
      role: action.destructive ? ('destructive' as const) : ('default' as const),
    })),
  });
  return answer.action ?? null;
}

export type Choice<T extends string> = { value: T; label: string; description?: string };

/** The sheets that are open, last on top. */
type SheetEntry = { id: number; props: SheetProps };

const sheets = signal<readonly SheetEntry[]>([]);
const closing = new Map<number, ReturnType<typeof setTimeout>>();
let nextSheet = 1;

function removeSheet(entry: SheetEntry) {
  closing.delete(entry.id);
  if (!sheets().includes(entry)) return;
  sheets.set(sheets().filter((one) => one !== entry));
}

/** A sheet closing waits one turn: a sheet opened in the same turn takes its
 * place in the same dialog, so UIKit never hears a dismissal and a
 * presentation at once (it drops the one asked for while the other goes). */
function setSheet(entry: SheetEntry, open: boolean) {
  const pending = closing.get(entry.id);
  if (open) {
    if (pending !== undefined) clearTimeout(pending);
    closing.delete(entry.id);
    if (!sheets().includes(entry)) sheets.set([...sheets(), entry]);
    return;
  }
  if (pending !== undefined || !sheets().includes(entry)) return;
  closing.set(
    entry.id,
    setTimeout(() => removeSheet(entry), 0),
  );
}

const topSheet = (): SheetEntry | null => {
  const open = sheets();
  return open.length ? open[open.length - 1]! : null;
};

/** Whether any sheet is open: one swapping for another keeps this true, so
 * the dialog node stays (a new node would dismiss and present at once). */
const sheetOpen = computed(() => !!topSheet());

/** The system sheet's content frame: it takes the keyboard's height, and the
 * popup keeps the app's background under the content. */
const SHEET_STYLE: StyleProp<ViewStyle> = { paddingBottom: 'env(keyboard-inset-height)' };
const SHEET_GRABBER: StyleProp<ViewStyle> = {
  width: 44,
  height: 6,
  borderRadius: 3,
  backgroundColor: alpha(colors.mutedForeground(), 0.35),
};
const sheetBackground = computed(() => colors.background());

/** The one `Dialog` every sheet shares (iOS). UIKit drops a presentation
 * asked for while another controller is still going away, and reports no
 * completion for an app-driven close: a sheet opened as one closes swaps
 * this dialog's content instead of presenting over it.
 *
 * Nothing here may follow the open sheets: reading which one is on top would
 * make the dialog node new for every swap (a dismissal and a presentation at
 * once, which UIKit drops). */
export function SheetHost() {
  return (
    <Dialog
      open={sheetOpen()}
      presentation="pageSheet"
      animation="slide"
      closeOnSwipe
      closeOnBackdropPress
      closeOnEscape
      onCancel={() => topSheet()?.props.onCancel?.()}
      onOpen={() => topSheet()?.props.onOpen?.()}
      onOpenChange={(event) => {
        const entry = topSheet();
        if (!entry) return;
        setSheet(entry, false);
        entry.props.onOpenChange?.(event);
      }}
      style={[SHEET_STYLE, { backgroundColor: sheetBackground() }]}
    >
      <If when={!!topSheet()}>
        {/* The sheet swipes but UIKit shows no handle of its own (Web draws one too). */}
        <View style={{ alignItems: 'center', paddingTop: 6, paddingBottom: 2 }}>
          <View style={SHEET_GRABBER} />
        </View>
        {topSheet()!.props.children}
      </If>
    </Dialog>
  );
}

/** A bottom sheet: on iOS it joins the shared `SheetHost` (which draws the
 * system sheet's frame); elsewhere it is the in-window `Sheet`, with the
 * sheet's own popup and backdrop styles. */
export function NativeSheet(props: SheetProps) {
  if (platform.os !== 'ios') return <Sheet {...props} />;
  const entry: SheetEntry = { id: nextSheet++, props };
  const wanted = () => !!(props.open ?? props.defaultOpen);
  effect(() => setSheet(entry, wanted()));
  cleanup(() => setSheet(entry, false));
  return null;
}

/** A choice list in the system's sheet presentation (Web's mobile picker). */
export function ChoiceSheet<T extends string>(props: {
  open: () => boolean;
  title?: string;
  options: () => Choice<T>[];
  value?: () => T | null;
  onSelect: (value: T) => void;
  onClose: () => void;
}) {
  const selected = () => props.value?.() ?? null;
  return (
    <NativeSheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.onClose();
      }}
      popupStyle={{ backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 }}
      backdropStyle={{ backgroundColor: alpha('#000000', 0.32) }}
    >
      <View style={{ paddingHorizontal: 12, paddingTop: 16, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <If when={!!props.title}>
          <Text
            style={{
              paddingHorizontal: 8,
              paddingBottom: 10,
              fontSize: fontSize.entityTitle,
              fontWeight: '600',
              color: colors.foreground(),
              numberOfLines: 1,
            }}
          >
            {props.title ?? ''}
          </Text>
        </If>
        <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.9) }}>
          <Each of={props.options()} key={(option) => option.value}>
            {(option) => (
              <Button
                onPress={() => {
                  props.onSelect(option().value);
                  props.onClose();
                }}
                activeStyle={{ backgroundColor: colors.accent() }}
                style={{
                  minHeight: 52,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 16, color: colors.foreground(), numberOfLines: 1 }}>{option().label}</Text>
                  <If when={!!option().description}>
                    <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                      {option().description ?? ''}
                    </Text>
                  </If>
                </View>
                <If when={selected() === option().value}>
                  <Icon name="check" size={18} />
                </If>
              </Button>
            )}
          </Each>
        </View>
        <Button
          onPress={props.onClose}
          style={{
            marginTop: 18,
            minHeight: 52,
            borderRadius: radius.inset,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: alpha(colors.muted(), 0.9),
          }}
        >
          <Text style={{ fontSize: 16, color: colors.foreground() }}>{t('gitView.common.cancel')}</Text>
        </Button>
      </View>
    </NativeSheet>
  );
}

/** Web `renderHighlightedText`: the search hit keeps the text and gains weight. */
export function Highlighted(props: {
  value: () => string;
  query?: () => string;
  class?: string;
  style?: StyleProp<TextStyle>;
}) {
  const parts = (): { text: string; hit: boolean }[] => {
    const value = props.value();
    const query = (props.query?.() ?? '').trim().toLowerCase();
    if (!query) return [{ text: value, hit: false }];
    const lower = value.toLowerCase();
    const out: { text: string; hit: boolean }[] = [];
    let index = 0;
    while (index < value.length) {
      const at = lower.indexOf(query, index);
      if (at < 0) {
        out.push({ text: value.slice(index), hit: false });
        break;
      }
      if (at > index) out.push({ text: value.slice(index, at), hit: false });
      out.push({ text: value.slice(at, at + query.length), hit: true });
      index = at + query.length;
    }
    return out;
  };
  return (
    <Text class={props.class} style={props.style}>
      <Each of={parts()} key="index">
        {(part) => <Text style={part().hit ? { fontWeight: '700' } : undefined}>{part().text}</Text>}
      </Each>
    </Text>
  );
}
