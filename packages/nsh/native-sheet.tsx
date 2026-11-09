import { cleanup, effect, keymap, nativeComponent, platform, signal, untracked, View, type NativeComponentRef } from 'nsh';
import { Dialog, Sheet, type SheetProps } from 'nsh/base';
import { createSheetPresentation, systemSheetContentStyle, type SheetPresentation } from './sheet-presentation';
import { nativeDensity } from './appearance';
import { nativeSheetSpacing } from './native-density';

export type NativeSheetDiagnostic = Readonly<{ owner: number; ticket: number; intent: number; ownerGeneration: number; revision: number; open: boolean; active: boolean; current: boolean; status: 'none' | 'pending' | 'complete' | 'failed' | 'cancelled' }>;

const Presentation = nativeComponent<{ generation: number; detents: readonly number[]; initialDetent: number; viewportDetents: boolean; dismissible: boolean; diagnostic?: NativeSheetDiagnostic }, {
  ready: { generation: number };
  opened: { generation: number };
  dismissed: { generation: number; interactive: boolean };
  cancel: { generation: number };
}>('yuri.sheet.presentation', { props: ['generation', 'detents', 'initialDetent', 'viewportDetents', 'dismissible', 'diagnostic'], events: ['ready', 'opened', 'dismissed', 'cancel'] });

export type NativeSheetProps = SheetProps & { detents?: readonly number[]; initialDetent?: number; viewportDetents?: boolean; diagnostic?: NativeSheetDiagnostic };

/** iOS uses a presented system sheet, never a View backdrop or app-owned pan. */
export function NativeSheet(props: NativeSheetProps) {
  if (platform.os !== 'ios') return <Sheet {...props} popupStyle={[...nativeSheetSpacing(props.popupClass, nativeDensity()), props.popupStyle]} />;
  const local = signal(props.defaultOpen ?? false), presentation = signal<SheetPresentation | null>(null);
  const owner = createSheetPresentation(value => presentation.set(value));
  const open = () => props.open ?? local();
  const cancel = () => {
    if (!open() || props.closeOnEscape === false) return;
    local.set(false); props.onCancel?.(); props.onOpenChange?.({ open: false, reason: 'cancel' });
  };
  effect(() => { const requested = open(); untracked(() => owner.request(requested)); });
  effect(() => {
    if (presentation()?.phase === 'open' && open() && props.closeOnEscape !== false) cleanup(keymap.bind('escape', cancel, { when: 'always' }));
  });
  cleanup(owner.dispose);
  return <Each of={presentation() ? [presentation()!.generation] : []}>{generation => {
    const id = generation(), ready = signal(false), native = signal<NativeComponentRef | null>(null);
    let finished = false;
    const dismiss = () => native()?.command('dismiss', { generation: id });
    const finish = (interactive: boolean) => {
      if (finished) return;
      finished = true;
      if (interactive) {
        local.set(false); props.onCancel?.(); props.onOpenChange?.({ open: false, reason: 'swipe' });
      }
      owner.dismissed(id, interactive); props.onClose?.();
    };
    effect(() => { const closing = presentation()?.generation === id && presentation()!.phase === 'closing'; if (closing && ready() && native()) untracked(dismiss); });
    cleanup(dismiss);
    return <Dialog open presentation="pageSheet" class="flex-1 bg-background" style={{ paddingBottom: 'env(keyboard-inset-height)' }} closeOnSwipe={false} closeOnBackdropPress={false} closeOnEscape={false}
      onCancel={cancel}>
      <Presentation generation={id} detents={props.detents ?? [.5, 1]} initialDetent={props.initialDetent ?? 0} viewportDetents={props.viewportDetents === true}
        diagnostic={props.diagnostic}
        dismissible={props.closeOnSwipe !== false && props.closeOnBackdropPress !== false}
        ref={ref => native.set(ref)} accessible={false} accessibilityElementsHidden style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
        onReady={event => { if (event.generation === id) ready.set(true); }}
        onOpened={event => { if (event.generation === id && owner.opened(id)) props.onOpen?.(); }}
        onDismissed={event => { if (event.generation === id) finish(event.interactive); }}
        onCancel={() => props.onCancel?.()} />
      <View testID={props.testID} class={`flex-1 ${(props.popupClass ?? '').split(/\s+/).filter(name => !/^rounded(?:-|$)/.test(name)).join(' ')}`}
        style={[{ paddingTop: 12 }, ...nativeSheetSpacing(props.popupClass, nativeDensity()), systemSheetContentStyle(props.popupStyle)]}>{props.children}</View>
    </Dialog>;
  }}</Each>;
}
