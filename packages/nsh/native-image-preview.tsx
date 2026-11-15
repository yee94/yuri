import {
  cleanup,
  createAnimatedValue,
  Easing,
  effect,
  Image,
  reduceMotion,
  safeArea,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  windowSize,
  type PressEvent,
  type ScrollRef,
  type ViewRef,
} from 'nsh';
import type { JSX } from 'nsh/types';
import { Button, Dialog } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import {
  NATIVE_IMAGE_PREVIEW_FADE_DURATION_MS,
  NATIVE_IMAGE_PREVIEW_MAX_SCALE,
  NATIVE_IMAGE_PREVIEW_OPEN_DURATION_MS,
  NATIVE_IMAGE_PREVIEW_RETURN_DURATION_MS,
  NATIVE_IMAGE_PREVIEW_TAP_DELAY_MS,
  nativeImagePreviewClampIndex,
  nativeImagePreviewCloseAnimation,
  nativeImagePreviewDismissPull,
  nativeImagePreviewDismissStyle,
  nativeImagePreviewDoubleTapScale,
  nativeImagePreviewFitFrame,
  nativeImagePreviewPageIndex,
  nativeImagePreviewShouldDismiss,
  nativeImagePreviewSourceRect,
  nativeImagePreviewTransition,
  type NativeImagePreviewRect,
  type NativeImagePreviewSize,
  type NativeImagePreviewTransition,
} from './native-image-preview-model';

/**
 * One image in the viewer: the caller's already-authorized thumbnail (`src`), an optional
 * already-authorized full-resolution URL (`fullSrc`), or `renderImage` for a native
 * original lease that must never be turned into a URL in JS.
 *
 * `renderImage` receives `fullscreen` and draws into its parent: the card clips it to the fixed
 * thumbnail frame, the viewer gives it the fitted frame. `intrinsicSize` is the metadata size
 * the caller read (`resources.read` width/height); without it the viewer fits the viewport and
 * the renderer's own `contain` decides the picture inside it.
 */
export type NativeImagePreviewItem = {
  /** `''` while a lease-owned original is loading or failed. */
  src: string;
  fullSrc?: string;
  label?: string;
  intrinsicSize?: NativeImagePreviewSize;
  renderImage?: (fullscreen: boolean) => JSX.Element;
};

export type NativeImagePreviewProps = {
  /** Shows while true. A user close runs the return animation before `onOpenChange(false)`. */
  open: boolean;
  items: readonly NativeImagePreviewItem[];
  /** The item shown first, and the one to follow while open. Default 0. */
  index?: number;
  /** The thumbnail's page frame when it was pressed: the origin of the opening animation. */
  sourceFrame?: NativeImagePreviewRect | null;
  /** Re-measured on close. `null` (source gone, recycled, unmounted) closes with a fade. */
  measureSource?: (index: number) => Promise<NativeImagePreviewRect | null>;
  /** The owning surface is still active; false closes immediately without animating. */
  active?: boolean;
  /**
   * The presented source identity (`src`/`fullSrc`/item index snapshot). A change while open
   * means the old surface is stale (List cell reuse, file replacement): it closes immediately
   * and never returns to the new source's frame.
   */
  identity?: string;
  /** Live owner fence, re-read at every async boundary: false closes immediately. */
  current?: () => boolean;
  onOpenChange: (open: boolean) => void;
  onIndexChange?: (index: number) => void;
  /** The dialog content left the native tree (or the user dismissed it): nothing is presented. */
  onClosed?: () => void;
  testID?: string;
};

export type NativeContentImageProps = {
  /** Authorized thumbnail URL, or `''` while the caller's owner is still loading or failed. */
  src: string;
  fullSrc?: string;
  label?: string;
  /** Defaults to true. False (page backgrounded, row inactive) closes an open viewer at once. */
  active?: boolean;
  /** Live fence for the owning row/message; read before opening and at every close boundary. */
  current?: () => boolean;
  /** Metadata pixel size (`resources.read` width) — the intrinsic aspect, not the card frame. */
  width?: number;
  /** Metadata pixel size (`resources.read` height) — the intrinsic aspect, not the card frame. */
  height?: number;
  /** Explicit thumbnail content frame width; defaults to 240, or 64 compact. */
  frameWidth?: number;
  /** Fixed thumbnail content frame height; defaults to 160, or 64 compact. Never follows metadata. */
  frameHeight?: number;
  /** Input-attachment size: a 64pt square frame and a tighter radius. */
  compact?: boolean;
  /** Extra caller identity in the source snapshot (lease generation, attachment id). */
  identity?: string;
  /** Draws the bitmap instead of `src`/`fullSrc`; fills its parent in both states. */
  renderImage?: (fullscreen: boolean) => JSX.Element;
  /** Metadata size (`resources.read` width/height), when not passed as `width`/`height`. */
  intrinsicSize?: NativeImagePreviewSize;
  /** Additional images to browse; when given it replaces the single-image list. */
  gallery?: readonly NativeImagePreviewItem[];
  /** Where this card's image sits in `gallery`. Default 0. */
  galleryIndex?: number;
  radius?: number;
  testID?: string;
  onOpenChange?: (open: boolean) => void;
  /**
   * The native Dialog finished dismissing (not `onOpenChange`, which fires a frame earlier).
   * Resolves only from the platform's completion; a close that finds nothing presented also
   * reports so a retirement cannot hang on a viewer that never opened.
   */
  onClosed?: () => void;
  /**
   * Retrofit for an owner that must retire before releasing a lease or popping its page:
   * `close()` requests the close and resolves on the native Dialog dismissal; it resolves
   * immediately when no viewer is presented. No timer stands in for the completion.
   */
  retirementOwner?: (retirement: { close: () => Promise<void> }) => void;
};

type PreviewPhase = 'closed' | 'open' | 'closing';
type CloseReason = 'return' | 'dismiss' | 'external' | 'inactive' | 'items';

const BLACK = '#000000';
const WHITE = '#ffffff';
const CONTROL_BACKGROUND = 'rgba(0,0,0,0.45)';
const COMPACT_FRAME = 64;
const DEFAULT_FRAME_WIDTH = 240;
const DEFAULT_FRAME_HEIGHT = 160;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const ease = Easing.bezier(0.2, 0, 0, 1);

/**
 * Fullscreen native viewer. The platform scroll view owns pinch zoom and two-axis panning, a
 * vertical scroll owns pull-to-dismiss, and JS owns only the source/return transition, the
 * gallery index and the close fences.
 */
export function NativeImagePreview(props: NativeImagePreviewProps) {
  const phase = signal<PreviewPhase>('closed');
  const index = signal(nativeImagePreviewClampIndex(props.index ?? 0, props.items.length));
  const viewport = signal<NativeImagePreviewSize>(windowSize());
  const scale = signal(1);
  const loaded = signal<Record<string, NativeImagePreviewSize>>({});
  const failed = signal<Record<string, boolean>>({});
  const transition = signal<NativeImagePreviewTransition | null>(null);

  const entry = createAnimatedValue(1);
  const fade = createAnimatedValue(1);
  const pull = createAnimatedValue(0);

  let epoch = 0;
  let tapTimer: number | undefined;
  /** A presentation is open (or opening): its native dismissal still owes an `onClosed`. */
  let dismissalPending = false;
  let dialogContent: ViewRef | null = null;
  let settleToken = 0;
  let disposed = false;
  const zoomRefs: (ScrollRef | null)[] = [];

  /** Fires once per presentation, from a real dismissal or a proven "not in the tree". */
  const settleDismissal = () => {
    if (!dismissalPending) return;
    dismissalPending = false;
    props.onClosed?.();
  };

  /**
   * `Dialog.onClose` only reports user dismissals (Escape, backdrop, swipe); a dialog the app
   * removes itself never calls it. The content view leaving the native tree is the provable
   * completion for that path, so poll its `measure()` (null once it is not in the tree) instead
   * of resolving on a timer. The loop stops on unmount, a new presentation or a phase change.
   */
  const settleWhenGone = () => {
    if (!dismissalPending) return;
    const token = ++settleToken;
    const poll = () => {
      if (disposed || token !== settleToken || !dismissalPending || phase() !== 'closed') return;
      const node = dialogContent;
      if (!node) { settleDismissal(); return; }
      void node.measure().then(measured => {
        if (disposed || token !== settleToken || !dismissalPending || phase() !== 'closed') return;
        if (!measured) { settleDismissal(); return; }
        setTimeout(poll, 16);
      }, () => {
        if (disposed || token !== settleToken) return;
        settleDismissal();
      });
    };
    setTimeout(poll, 0);
  };

  const itemAt = (at: number): NativeImagePreviewItem | null => props.items[at] ?? null;
  const current = (): NativeImagePreviewItem | null => itemAt(nativeImagePreviewClampIndex(index(), props.items.length));
  const pageWidth = (): number => Math.max(1, viewport().width);
  const pageHeight = (): number => Math.max(1, viewport().height);
  const zoomed = (): boolean => scale() > 1.01;
  const ownerCurrent = (): boolean => props.current?.() ?? true;
  const stillCurrent = (): boolean => props.active !== false && ownerCurrent();

  const sourceOf = (item: NativeImagePreviewItem | null): string => (item ? item.fullSrc || item.src || '' : '');
  const naturalOf = (item: NativeImagePreviewItem | null): NativeImagePreviewSize | null => {
    if (!item) return null;
    if (item.intrinsicSize && item.intrinsicSize.width > 0 && item.intrinsicSize.height > 0) return item.intrinsicSize;
    return loaded()[sourceOf(item)] ?? null;
  };
  const frameOf = (item: NativeImagePreviewItem | null) => nativeImagePreviewFitFrame(naturalOf(item), viewport());

  const clearTap = () => {
    if (tapTimer !== undefined) clearTimeout(tapTimer);
    tapTimer = undefined;
  };

  const entryX = () => {
    const from = transition();
    return from ? entry.interpolate({ inputRange: [0, 1], outputRange: [from.x, 0] }) : 0;
  };
  const entryY = () => {
    const from = transition();
    return from ? entry.interpolate({ inputRange: [0, 1], outputRange: [from.y, 0] }) : 0;
  };
  const entryScale = () => {
    const from = transition();
    return from ? entry.interpolate({ inputRange: [0, 1], outputRange: [from.scale, 1] }) : 1;
  };
  const dismissScale = () => {
    if (zoomed()) return 1;
    const height = pageHeight();
    const limit = nativeImagePreviewDismissPull(height);
    return pull.interpolate({
      inputRange: [0, limit],
      outputRange: [1, nativeImagePreviewDismissStyle(limit, height).scale],
    });
  };
  const pullOpacity = () => {
    if (zoomed()) return 1;
    const height = pageHeight();
    const limit = nativeImagePreviewDismissPull(height);
    return pull.interpolate({
      inputRange: [0, limit],
      outputRange: [1, nativeImagePreviewDismissStyle(limit, height).opacity],
    });
  };
  const backdropOpacity = () => entry.mul(fade).mul(pullOpacity());

  const resetZoom = () => {
    zoomRefs[index()]?.zoomTo({ scale: 1, animated: true });
    scale.set(1);
  };

  let pagerRef: ScrollRef | null = null;

  const selectIndex = (next: number, scrollPager = false) => {
    if (next === index()) return;
    clearTap();
    index.set(next);
    scale.set(1);
    transition.set(null);
    entry.set(1);
    zoomRefs[next]?.zoomTo({ scale: 1, animated: false });
    if (scrollPager) pagerRef?.scrollTo({ x: next * pageWidth(), animated: true });
    props.onIndexChange?.(next);
  };

  const finishClose = (notify: boolean) => {
    phase.set('closed');
    clearTap();
    entry.set(1);
    fade.set(1);
    pull.set(0);
    transition.set(null);
    scale.set(1);
    settleWhenGone();
    if (notify) props.onOpenChange(false);
  };

  /** A fence lost (owner gone, surface inactive, empty gallery): nothing may outlive the authority. */
  const closeImmediately = (notify: boolean) => {
    epoch += 1;
    if (phase() === 'closed') return;
    finishClose(notify);
  };

  const startOpen = () => {
    if (props.items.length === 0) return;
    epoch += 1;
    dismissalPending = true;
    const next = nativeImagePreviewClampIndex(props.index ?? 0, props.items.length);
    index.set(next);
    scale.set(1);
    const from = props.sourceFrame
      ? nativeImagePreviewTransition(naturalOf(itemAt(next)), viewport(), props.sourceFrame)
      : null;
    transition.set(from);
    entry.set(from ? 0 : 1);
    fade.set(from ? 1 : 0);
    pull.set(0);
    phase.set('open');
    if (reduceMotion()) {
      entry.set(1);
      fade.set(1);
    } else if (from) {
      void entry.timing(1, { duration: NATIVE_IMAGE_PREVIEW_OPEN_DURATION_MS, easing: ease });
    } else {
      void fade.timing(1, { duration: NATIVE_IMAGE_PREVIEW_FADE_DURATION_MS, easing: ease });
    }
  };

  const requestClose = (reason: CloseReason) => {
    if (phase() !== 'open') return;
    if (!stillCurrent()) {
      closeImmediately(true);
      return;
    }
    const token = (epoch += 1);
    clearTap();
    phase.set('closing');
    void (async () => {
      const measured = reason === 'return' && props.measureSource
        ? await props.measureSource(index()).catch(() => null)
        : null;
      if (token !== epoch || phase() !== 'closing') return;
      const from = measured ? nativeImagePreviewTransition(naturalOf(current()), viewport(), measured) : null;
      const animation = nativeImagePreviewCloseAnimation(from, reduceMotion());
      if (animation === 'source' && from) {
        transition.set(from);
        await entry.timing(0, { duration: NATIVE_IMAGE_PREVIEW_RETURN_DURATION_MS, easing: ease });
      } else {
        await fade.timing(0, { duration: NATIVE_IMAGE_PREVIEW_FADE_DURATION_MS, easing: ease });
      }
      if (token !== epoch || phase() !== 'closing') return;
      if (!stillCurrent()) {
        closeImmediately(true);
        return;
      }
      finishClose(true);
    })();
  };

  /** A tap waits out the double-tap window; a second press zooms around its own point. */
  const pressImage = (event: PressEvent, page: number) => {
    if (event.clickCount >= 2) {
      clearTap();
      const next = nativeImagePreviewDoubleTapScale(scale());
      if (next === 1) {
        resetZoom();
      } else {
        const frame = frameOf(itemAt(page));
        zoomRefs[page]?.zoomTo({ scale: next, x: frame.rect.x + event.position.x, y: frame.rect.y + event.position.y, animated: true });
        scale.set(next);
      }
      return;
    }
    clearTap();
    tapTimer = setTimeout(() => {
      tapTimer = undefined;
      requestClose('return');
    }, NATIVE_IMAGE_PREVIEW_TAP_DELAY_MS);
  };

  effect(() => {
    const requested = props.open === true;
    const active = props.active !== false;
    const length = props.items.length;
    untracked(() => {
      if (!requested) {
        if (phase() === 'open') requestClose('external');
        return;
      }
      if (!active || length === 0) {
        if (phase() === 'closed') {
          dismissalPending = true;
          settleWhenGone();
          props.onOpenChange(false);
        } else closeImmediately(true);
        return;
      }
      if (phase() === 'closed') startOpen();
    });
  });

  effect(() => {
    const requested = props.index;
    const length = props.items.length;
    untracked(() => {
      if (phase() === 'closed' || requested === undefined) return;
      selectIndex(nativeImagePreviewClampIndex(requested, length), true);
    });
  });

  // A changed source identity while open means the old surface is stale: close it at once.
  // Comparing the value (not merely "the effect ran") keeps a late metadata render from closing.
  let lastIdentity = props.identity;
  effect(() => {
    const identity = props.identity;
    untracked(() => {
      if (identity === undefined || identity === lastIdentity) return;
      lastIdentity = identity;
      if (phase() === 'closed') return;
      closeImmediately(true);
    });
  });

  effect(() => {
    const length = props.items.length;
    untracked(() => {
      if (phase() === 'closed') return;
      if (length === 0) {
        closeImmediately(true);
        return;
      }
      selectIndex(nativeImagePreviewClampIndex(index(), length), true);
    });
  });

  cleanup(() => {
    disposed = true;
    epoch += 1;
    settleToken += 1;
    clearTap();
  });

  // A preview mounted already closed (the owner closed it before its first frame) still owes
  // the completion proof: its dialog content is not in the tree.
  if (props.open !== true) {
    dismissalPending = true;
    settleWhenGone();
  }

  /** The image's own scroll view owns the downward pull, so release can dismiss before it springs back. */
  const settleDismiss = () => {
    if (phase() !== 'open' || zoomed()) return;
    void pull.getValue().then(value => {
      if (phase() !== 'open' || zoomed()) return;
      if (nativeImagePreviewShouldDismiss(Math.max(0, value), pageHeight())) requestClose('dismiss');
    }).catch(() => {});
  };

  const insets = () => safeArea();
  return <Dialog
    testID={props.testID ?? 'image-preview'}
    presentation="fullScreen"
    open={phase() !== 'closed'}
    animation="none"
    closeOnSwipe={false}
    closeOnBackdropPress={false}
    closeOnEscape={false}
    onCancel={() => requestClose('return')}
    onClose={() => settleDismissal()}
    class="flex-1">
    <View ref={ref => { dialogContent = ref; }} style={{ flex: 1, backgroundColor: BLACK }}
      onLayout={event => {
        const width = event.bounds.size.width, height = event.bounds.size.height;
        if (width > 0 && height > 0 && (width !== viewport().width || height !== viewport().height)) {
          viewport.set({ width, height });
        }
      }}>
      <View class="absolute inset-0" style={{ backgroundColor: BLACK, opacity: backdropOpacity() }} />
      <Scroll
        testID="image-preview-pager"
        ref={ref => { pagerRef = ref; }}
        horizontal
        pagingEnabled
        scrollbar={false}
        bounces={props.items.length > 1}
        scrollEventThrottle={50}
        style={{ flex: 1 }}
        onScroll={event => {
          if (phase() !== 'open') return;
          selectIndex(nativeImagePreviewPageIndex(event.offset.x, pageWidth(), props.items.length));
        }}>
        <View style={{ width: pageWidth() * Math.max(1, props.items.length), height: pageHeight(), flexDirection: 'row' }}>
          <Each of={props.items}>{(item, position) => {
            const at = (): number => position();
            return <View style={{ width: pageWidth(), height: pageHeight(), scale: dismissScale(), overflow: 'hidden' }}>
              <Scroll
                ref={ref => { zoomRefs[at()] = ref; }}
                class="flex-1"
                style={{ flex: 1 }}
                scrollbar={false}
                bounces
                pullValue={pull}
                minimumZoomScale={1}
                maximumZoomScale={NATIVE_IMAGE_PREVIEW_MAX_SCALE}
                scrollEventThrottle={50}
                onScroll={event => { if (at() === index()) scale.set(event.zoomScale); }}
                onScrollDragStart={() => pull.set(0)}
                onScrollDragEnd={() => { if (at() === index()) settleDismiss(); }}>
                <View style={{ width: pageWidth(), height: pageHeight(), alignItems: 'center', justifyContent: 'center' }}>
                <View
                  testID={at() === index() ? 'image-preview-image' : undefined}
                  accessibilityLabel={at() === index() ? (item().label || t('filesView.editor.imageAltFallback')) : undefined}
                  role="image"
                  onPress={event => { if (at() === index()) pressImage(event, at()); }}
                  style={{
                    width: frameOf(item()).size.width,
                    height: frameOf(item()).size.height,
                    translate: at() === index() ? [entryX(), entryY()] : [0, 0],
                    scale: at() === index() ? entryScale() : 1,
                  }}>
                  <PageBody
                    item={item()}
                    source={sourceOf(item())}
                    failed={!!failed()[sourceOf(item())]}
                    onLoad={size => loaded.set({ ...loaded(), [sourceOf(item())]: size })}
                    onError={() => failed.set({ ...failed(), [sourceOf(item())]: true })} />
                </View>
                </View>
              </Scroll>
            </View>;
          }}</Each>
        </View>
      </Scroll>
      <View class="absolute inset-0" style={{ pointerEvents: 'box-none', opacity: backdropOpacity() }}>
        <Button
          testID="image-preview-close"
          accessibilityLabel={t('dialog.common.actions.close')}
          class="absolute items-center justify-center"
          style={{ top: insets().top + 8, right: insets().right + 12, width: 36, height: 36, borderRadius: 18, backgroundColor: CONTROL_BACKGROUND }}
          onPress={() => requestClose('return')}>
          <Icon name="close" size={20} color={WHITE} />
        </Button>
        <View class="absolute flex-row items-center gap-2" style={{ bottom: insets().bottom + 16, left: 0, right: 0, justifyContent: 'center' }}>
          <If when={props.items.length > 1}>
            <View style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: CONTROL_BACKGROUND }}>
              <Text testID="image-preview-counter" style={{ color: WHITE, fontSize: 12 }}>{`${index() + 1} / ${props.items.length}`}</Text>
            </View>
          </If>
          <Button
            testID="image-preview-zoom-reset"
            accessibilityLabel={t('chat.toolOutputDialog.image.resetZoomAria')}
            class="flex-row items-center justify-center gap-1"
            style={{ paddingHorizontal: 10, height: 28, borderRadius: 14, backgroundColor: CONTROL_BACKGROUND }}
            onPress={resetZoom}>
            <Icon name="restart" size={13} color={WHITE} />
            <Text testID="image-preview-zoom-label" style={{ color: WHITE, fontSize: 12 }}>{`${Math.round(scale() * 100)}%`}</Text>
          </Button>
        </View>
      </View>
    </View>
  </Dialog>;
}

function PageBody(props: {
  item: NativeImagePreviewItem;
  source: string;
  failed: boolean;
  onLoad: (size: NativeImagePreviewSize) => void;
  onError: () => void;
}) {
  if (props.item.renderImage) {
    return <View style={{ width: '100%', height: '100%' }}>{props.item.renderImage(true)}</View>;
  }
  if (!props.source || props.failed) {
    return <View class="flex-1 items-center justify-center gap-2">
      <Icon name="file-image" size={28} color={WHITE} />
      <Text style={{ color: WHITE, fontSize: 13 }}>{t('chat.fileAttachment.image.loadFailed')}</Text>
    </View>;
  }
  return <Image
    src={props.source}
    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
    fadeDuration={0}
    onLoad={event => {
      if (event.size.width > 0 && event.size.height > 0) props.onLoad({ width: event.size.width, height: event.size.height });
    }}
    onError={props.onError} />;
}

/**
 * A fixed-frame thumbnail that opens the fullscreen viewer on press. The frame never depends on
 * load state, so a row's height cannot change when the bitmap arrives or fails; the caller's
 * owner keeps retry/loading labels.
 */
export function NativeContentImage(props: NativeContentImageProps) {
  let root: ViewRef | null = null;
  const viewer = signal(false);
  const closeRequested = signal(false);
  const origin = signal<NativeImagePreviewRect | null>(null);
  const failed = signal(false);
  const loadedSize = signal<NativeImagePreviewSize | null>(null);
  let closeWaiters: (() => void)[] = [];
  /** Invalidates a measurement that has not yet mounted the viewer. */
  let openToken = 0;
  let alive = true;

  const compact = (): boolean => props.compact === true;
  const intrinsicSize = (): NativeImagePreviewSize | undefined => {
    if (props.intrinsicSize && props.intrinsicSize.width > 0 && props.intrinsicSize.height > 0) return props.intrinsicSize;
    if (props.width && props.width > 0 && props.height && props.height > 0) {
      return { width: props.width, height: props.height };
    }
    return loadedSize() ?? undefined;
  };
  const frameWidth = (): number => Math.max(1, props.frameWidth ?? (compact() ? COMPACT_FRAME : DEFAULT_FRAME_WIDTH));
  // A message frame is fixed at 160pt like the Web contentFrame: late metadata never resizes it.
  const frameHeight = (): number => Math.max(1, props.frameHeight ?? (compact() ? COMPACT_FRAME : DEFAULT_FRAME_HEIGHT));
  const imageLabel = (): string => props.label || t('filesView.editor.imageAltFallback');
  const renderable = (): boolean => Boolean(props.src) || Boolean(props.renderImage);
  const stillActive = (): boolean => props.active !== false && (props.current?.() ?? true);

  const ownItem = (): NativeImagePreviewItem => ({
    src: props.src,
    fullSrc: props.fullSrc,
    label: props.label,
    intrinsicSize: intrinsicSize(),
    renderImage: props.renderImage,
  });
  const previewItems = (): readonly NativeImagePreviewItem[] => (
    props.gallery && props.gallery.length > 0 ? props.gallery : [ownItem()]
  );
  const previewIndex = (): number => (
    props.gallery && props.gallery.length > 0
      ? nativeImagePreviewClampIndex(props.galleryIndex ?? 0, props.gallery.length)
      : 0
  );
  /**
   * Source identity, not metadata: a reused List cell or a replaced file changes it and closes
   * the old surface; a late width/height for the same source does not.
   */
  const sourceIdentity = (): string => {
    const index = previewIndex();
    const item = previewItems()[index];
    return [props.identity ?? '', String(index), item?.src ?? '', item?.fullSrc ?? ''].join('\n');
  };

  /**
   * The source transition rect: the letterboxed picture inside a message frame (contain) or
   * the cropped frame itself (compact cover). Unknown dimensions return null, a fade.
   */
  const measure = async (): Promise<NativeImagePreviewRect | null> => {
    const node = root;
    if (!node) return null;
    const measured = await node.measure();
    if (!measured || !(measured.bounds.size.width > 0) || !(measured.bounds.size.height > 0)) return null;
    return nativeImagePreviewSourceRect({
      x: measured.pagePosition.x,
      y: measured.pagePosition.y,
      width: measured.bounds.size.width,
      height: measured.bounds.size.height,
    }, intrinsicSize(), compact() ? 'cover' : 'contain');
  };

  const openViewer = () => {
    const token = ++openToken;
    void (async () => {
      if (!renderable() || !stillActive()) return;
      const frame = await measure();
      if (!alive || token !== openToken || !stillActive()) return;
      origin.set(frame);
      closeRequested.set(false);
      viewer.set(true);
      props.onOpenChange?.(true);
    })();
  };

  /**
   * Whoever retires the owner awaits this. Only "no open request at all" resolves at once:
   * `viewer()` true means a dialog may already have been dispatched, so the promise waits for
   * the preview's proven dismissal (content left the tree) even if it never reported opening.
   */
  const closeViewer = (): Promise<void> => {
    // Cancelling the measurement makes "no viewer yet" a proof that nothing will present.
    openToken += 1;
    if (!viewer()) return Promise.resolve();
    closeRequested.set(true);
    return new Promise<void>(resolve => { closeWaiters = [...closeWaiters, resolve]; });
  };

  props.retirementOwner?.({ close: closeViewer });

  const viewerClosed = () => {
    viewer.set(false);
    closeRequested.set(false);
    const waiting = closeWaiters;
    closeWaiters = [];
    waiting.forEach(resolve => resolve());
    props.onClosed?.();
  };

  effect(() => {
    props.src;
    untracked(() => { failed.set(false); loadedSize.set(null); });
  });

  let lastIdentity = sourceIdentity();
  effect(() => {
    const key = sourceIdentity();
    untracked(() => {
      if (key === lastIdentity) return;
      lastIdentity = key;
      // A measure that has not presented yet belongs to the previous source: abort it.
      openToken += 1;
    });
  });

  cleanup(() => {
    alive = false;
    openToken += 1;
    const waiting = closeWaiters;
    closeWaiters = [];
    waiting.forEach(resolve => resolve());
  });

  return <View
    testID={props.testID}
    ref={ref => { root = ref; }}
    disabled={!renderable()}
    role="imagebutton"
    accessibilityLabel={imageLabel()}
    onPress={openViewer}
    activeStyle={{ opacity: 0.88 }}
    class="overflow-hidden bg-secondary"
    style={{ width: frameWidth(), height: frameHeight(), maxWidth: '100%', borderRadius: props.radius ?? (compact() ? 8 : 16) }}>
    <If when={!!props.renderImage}>
      <View style={{ width: '100%', height: '100%' }}>{props.renderImage ? props.renderImage(false) : null}</View>
    </If>
    <If when={!props.renderImage && !!props.src && !failed()}>
      <Image
        src={props.src}
        style={{ width: '100%', height: '100%', objectFit: compact() ? 'cover' : 'contain' }}
        fadeDuration={0}
        onLoad={event => {
          if (event.size.width > 0 && event.size.height > 0) loadedSize.set({ width: event.size.width, height: event.size.height });
        }}
        onError={() => failed.set(true)} />
    </If>
    <If when={!props.renderImage && (!props.src || failed())}>
      <View class="flex-1 items-center justify-center">
        <Icon name="file-image" size={compact() ? 20 : 28} />
      </View>
    </If>
    <If when={viewer()}>
      <NativeImagePreview
        open={!closeRequested()}
        items={previewItems()}
        index={previewIndex()}
        sourceFrame={origin()}
        measureSource={measure}
        active={props.active !== false}
        current={props.current}
        identity={sourceIdentity()}
        testID={props.testID ? `${props.testID}-preview` : undefined}
        onClosed={viewerClosed}
        onOpenChange={open => {
          if (open) {
            closeRequested.set(false);
            return;
          }
          // Keep the native dialog mounted until its dismissal completion reports `onClosed`.
          closeRequested.set(true);
          props.onOpenChange?.(false);
        }} />
    </If>
  </View>;
}
