import { cleanup, effect, signal, untracked, type JSX } from 'nsh';
import { NativeSheet } from './native-sheet';
import { createNewSessionModalOwner, type NewSessionModalPresentation } from './new-session-modal-owner';
import { createModelPickerSheet, type ModelPickerSheet } from './model-picker-presentation';

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
    const close = () => { if (owner.close(id)) props.onClose(); };
    const sheet = createModelPickerSheet(close);
    const finish = () => {
      const result = owner.dialogClosed(id);
      if (result === 'interrupted') props.onClose();
      if (result !== 'stale') props.onDismiss?.(value);
    };
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
