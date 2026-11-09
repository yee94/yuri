import { batch, cleanup, computed, effect, platform, signal, untracked, windowSize, type JSX } from 'nsh';
import { Dialog } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { createNewSessionModalOwner, type NewSessionModalPresentation } from './new-session-modal-owner';
import { createModelPickerSheet, type ModelPickerSheet } from './model-picker-presentation';

/** Desktop dialogs have no native sheet transition; release at their actual subtree disposal. */
function DesktopPickerLifetime(props: { onDispose: () => void; children?: JSX.Element }) {
  cleanup(props.onDispose);
  return props.children;
}

/** The selection generation stays alive until the system sheet's real dismissal. */
export function NativeNewSessionModal<T extends string>(props: {
  value: T | null;
  active: () => boolean;
  onClose: () => void;
  onDismiss?: (value: T) => void;
  height: number;
  children: (value: T, active: () => boolean, close: () => void, sheet: ModelPickerSheet) => JSX.Element;
}) {
  const presentation = signal<NewSessionModalPresentation<T> | null>(null);
  const owner = createNewSessionModalOwner<T>(next => presentation.set(next));
  effect(() => { const value = props.active() ? props.value : null; untracked(() => owner.request(value)); });
  cleanup(owner.dispose);
  return <Each of={presentation() ? [presentation()!.generation] : []}>{generation => {
    const id = generation(), value = presentation()!.value;
    const phase = () => presentation()?.generation === id ? presentation()!.phase : 'native-dismissing';
    const active = () => props.active() && props.value === value && presentation()?.generation === id && (phase() === 'sheet-opening' || phase() === 'open');
    const close = () => { batch(() => { if (owner.close(id)) props.onClose(); }); };
    const sheet = createModelPickerSheet(close);
    const finish = () => {
      const result = owner.dialogClosed(id);
      if (result === 'interrupted') props.onClose();
      if (result !== 'stale') props.onDismiss?.(value);
    };
    if (platform?.desktop) {
      // Do not rebuild Dialog when only its admission phase changes while open.
      const dialogOpen = computed(() => phase() === 'native-opening' || phase() === 'native-opening-cancelled' || phase() === 'sheet-opening' || phase() === 'open');
      return <Dialog testID="desktop-new-session-picker" open={dialogOpen()} animation="none" closeOnEscape closeOnBackdropPress closeOnSwipe={false}
        onOpen={() => { owner.dialogOpened(id); owner.sheetOpened(id); }} onOpenChange={event => { if (!event.open) close(); }} onClose={finish}
        class="bg-popover border border-border rounded-xl p-3" backdropClass="bg-background/60" style={{ width: Math.min(560, windowSize().width - 48), height: Math.min(640, windowSize().height - 96), maxHeight: '85%' }}>
        <DesktopPickerLifetime onDispose={finish}><Each of={[id]}>{() => props.children(value, active, close, sheet)}</Each></DesktopPickerLifetime>
      </Dialog>;
    }
    return <NativeSheet open={phase() === 'native-opening' || phase() === 'native-opening-cancelled' || phase() === 'sheet-opening' || phase() === 'open'} closeOnSwipe
      detents={value === 'model' || value === 'agent' ? [.72, .98] : [.5, 1]}
      onOpen={() => { owner.dialogOpened(id); owner.sheetOpened(id); }}
      onOpenChange={event => { if (!event.open) close(); }} onClose={finish}
      popupClass="bg-background" popupStyle={{ height: value === 'model' || value === 'agent' ? sheet.height() : props.height }}>
      <Each of={[id]}>{() => <>
        {props.children(value, active, close, sheet)}
      </>}</Each>
    </NativeSheet>;
  }}</Each>;
}
