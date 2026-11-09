import { cleanup, computed, effect, platform, signal, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import { isAvailable, Menu, titleBar, Window } from 'nsh/desktop';
import { t } from './i18n';
import { Icon } from './Icon';
import { createNativeDesktopMenuOwner, nativeDesktopMenuItems, nativeDesktopMenuKeystrokes, nativeDesktopTitleBarLayout, type NativeDesktopActions } from './desktop-core';
import type { ShortcutOverrides } from './desktop-shortcuts-core';

let menuMounted = false, titleBarMounted = false;

/** Call once under the application root's NSH owner, not under a route. */
export function installNativeDesktopMenu(actions: () => NativeDesktopActions, shortcuts: {
  userOverrides?: () => ShortcutOverrides;
  ready?: () => boolean;
  /** Inject false for a headless desktop model: NSH isAvailable only checks OS,
   * while hardware menu accelerator dispatch needs an actual native window. */
  ownsAccelerators?: () => boolean;
} = {}) {
  if (isAvailable && menuMounted) throw new Error('Native desktop menu already installed');
  if (isAvailable) menuMounted = true;
  const owner = createNativeDesktopMenuOwner({ available: isAvailable,
    setApplicationMenu: items => Menu.setApplicationMenu(items),
    popup: items => Menu.popup(items),
  });
  const ownedKeystrokes = signal<readonly string[]>([]);
  cleanup(() => {
    try { owner.dispose(); }
    finally { ownedKeystrokes.set([]); if (isAvailable) menuMounted = false; }
  });
  const items = computed(() => nativeDesktopMenuItems(platform.os, actions(), t, { userOverrides: shortcuts.userOverrides?.(), ready: shortcuts.ready?.() }));
  effect(() => {
    const next = items();
    owner.update(next);
    // Publish after a successful install call; a failed replacement owns prior keys.
    ownedKeystrokes.set(isAvailable && shortcuts.ownsAccelerators?.() !== false ? nativeDesktopMenuKeystrokes(next) : []);
  });
  return { items, ownedKeystrokes, popup: owner.popup, popupApplication: owner.popupApplication };
}

/** System controls remain native. Browser desktop layout never acquires Window APIs. */
export function NativeDesktopTitleBar(props: {
  title: string;
  height?: number;
  menu?: ReturnType<typeof installNativeDesktopMenu>;
  leading?: JSX.Element;
  heading?: JSX.Element;
  /** Heading's requested start from the window's left edge, including native insets. */
  leadingWidth?: number;
  children?: JSX.Element;
}) {
  if (!platform.desktop) return null;
  if (isAvailable && titleBarMounted) throw new Error('Native desktop title bar already mounted');
  if (isAvailable) {
    titleBarMounted = true;
    cleanup(() => {
      try { Window.setTitleBar({ style: 'default' }); }
      finally { titleBarMounted = false; }
    });
    effect(() => Window.setTitle(props.title));
    effect(() => Window.setTitleBar({ style: 'hidden', height: props.height ?? 40 }));
  }
  const layout = () => nativeDesktopTitleBarLayout(isAvailable ? titleBar() : { height: 0, left: 0, right: 0 }, props.height ?? 40);
  const opened = signal(false);
  let popupRevision = 0;
  cleanup(() => { popupRevision++; });
  const open = async () => {
    if (!isAvailable || !props.menu || opened()) return;
    const captured = ++popupRevision;
    opened.set(true);
    try { await props.menu.popupApplication(); }
    finally { if (captured === popupRevision) opened.set(false); }
  };
  const showsMenu = () => isAvailable && platform.os !== 'macos' && !!props.menu;
  const leadingWidth = () => props.leadingWidth !== undefined && Number.isFinite(props.leadingWidth)
    ? Math.max(0, props.leadingWidth - layout().paddingLeft - 8) : undefined;
  return <View testID="native-desktop-titlebar" desktop={{ windowDrag: isAvailable }} class="bg-background flex-row items-center gap-2 min-w-0" style={{ ...layout(), flexShrink: 0 }}>
    <If when={props.leading != null || props.leadingWidth !== undefined || showsMenu()}>
      <View testID="native-desktop-leading" desktop={{ windowDrag: false }} class="flex-row items-center gap-2 min-w-0" style={{ width: leadingWidth(), flexShrink: 1 }}>
        <If when={showsMenu()}>
          <Button testID="native-desktop-app-menu" accessibilityLabel={t('header.actions.openAppMenuAria')}
            class="size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent active:bg-accent" classList={{ 'bg-accent': opened() }} onPress={() => { void open(); }}>
            <Icon name="menu-2" size={18} />
          </Button>
        </If>
        {props.leading}
      </View>
    </If>
    <View testID="native-desktop-heading-region" class="flex-1 flex-row items-center min-w-0">
      <View testID="native-desktop-heading" desktop={{ windowDrag: false }} style={{ minWidth: 0, maxWidth: '100%', flexShrink: 1 }}>
        {props.heading ?? <Text testID="native-desktop-title" class="text-foreground" style={{ fontSize: 13, numberOfLines: 1 }}>{props.title}</Text>}
      </View>
    </View>
    <View testID="native-desktop-actions" desktop={{ windowDrag: false }} class="flex-row items-center" style={{ flexShrink: 0 }}>{props.children}</View>
  </View>;
}
