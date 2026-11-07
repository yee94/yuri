import { platform, safeArea, signal, Text, View, windowSize } from 'nsh';
import { Button } from 'nsh/base';
import { inlineModelVariants, modelVariants, pickerSheetHeight, variantLabel, type PickerModel } from './chat-models-helpers';
import { t } from './i18n';
import { Icon } from './Icon';
import { NativeModelLogo } from './chat-identity';
import { modelLabel } from './chat-models-helpers';
import { releaseHeightVelocity, resolveHeightSnap, sampleHeight, type HeightSample } from '../ui/src/components/ui/heightSnapPhysics';

export function createModelPickerSheet(onClose: () => void) {
  const expanded = signal(false), dragging = signal<number | null>(null);
  const collapsed = () => pickerSheetHeight(windowSize().height, safeArea());
  const maximum = () => pickerSheetHeight(windowSize().height, safeArea(), true);
  const height = () => dragging() ?? (expanded() ? maximum() : collapsed());
  let start = 0;
  const samples: HeightSample[] = [];
  return {
    height,
    reset() { expanded.set(false); dragging.set(null); },
    start(time = Date.now()) { start = height(); samples.length = 0; sampleHeight(samples, start, time); },
    move(dy: number, end = false, time = Date.now()) {
      const next = Math.max(0, Math.min(maximum(), start - dy));
      sampleHeight(samples, next, time);
      if (!end) { dragging.set(next); return; }
      dragging.set(null);
      const velocity = releaseHeightVelocity(samples, time);
      if (next <= collapsed() - 64 || velocity < -0.55 && start <= collapsed() + 1 && next < collapsed() - 8) { onClose(); return; }
      expanded.set(resolveHeightSnap([{ id: false, height: collapsed() }, { id: true, height: maximum() }], expanded(), next, velocity, -dy));
    },
    cancel() { dragging.set(null); },
  };
}
export type ModelPickerSheet = ReturnType<typeof createModelPickerSheet>;

/** Only the grabber claims resize gestures; list scrolling stays with Sheet/Scroll. */
export function NativeModelPickerHandle(props: { sheet?: ModelPickerSheet }) {
  if (platform.os === 'ios') return null;
  let origin = 0;
  return <View testID="model-picker-resize" accessibilityLabel={t('contextPanel.actions.resizePanel')} class="items-center justify-center" style={{ height: 26 }} onStartShouldSetResponder={() => !!props.sheet} onResponderGrant={event => { origin = event.pageY; props.sheet?.start(event.timestamp); return true; }} onResponderMove={event => props.sheet?.move(event.pageY - origin, false, event.timestamp)} onResponderRelease={event => props.sheet?.move(event.pageY - origin, true, event.timestamp)} onResponderTerminate={() => props.sheet?.cancel()} onResponderTerminationRequest={() => false}><View class="bg-muted-foreground/40 rounded-full" style={{ width: 46, height: 5 }} /></View>;
}

export function NativeModelVariants(props: { entry: PickerModel; selected?: string; disabled: boolean; id: string; full?: boolean; onSelect: (variant: string) => void; onMore?: () => void }) {
  return <View class={props.full ? 'gap-1.5' : 'flex-row flex-wrap gap-2 px-3 pb-3'}><Each of={props.full ? ['', ...modelVariants(props.entry)] : inlineModelVariants(props.entry)}>{variant => <Button testID={`${props.id}-${variant() || 'default'}`} class={(props.full ? 'min-h-11 px-3 py-2 rounded-xl flex-row items-center justify-between ' : 'min-h-9 px-3 rounded-full items-center justify-center ') + 'border border-border/40 active:bg-accent disabled:opacity-40 ' + ((props.selected || '') === variant() ? 'bg-accent/15' : '')} selected={(props.selected || '') === variant()} disabled={props.disabled} onPress={() => props.onSelect(variant())}><Text class="text-sm text-foreground">{variantLabel(variant(), t('chat.modelControls.default'))}</Text><If when={props.full && (props.selected || '') === variant()}><Icon name="check" size={16} /></If></Button>}</Each><If when={!props.full && modelVariants(props.entry).length > 7}><Button testID={`${props.id}-more`} class="min-h-9 px-3 rounded-full border border-border/40 items-center justify-center" disabled={props.disabled} accessibilityLabel={t('chat.modelControls.moreThinkingModes')} onPress={() => props.onMore?.()}><Text class="text-sm text-muted-foreground">{t('inlineComment.actions.showMore')}</Text></Button></If></View>;
}

export function NativeModelVariantHeader(props: { entry: PickerModel; onBack: () => void; onClose: () => void }) {
  return <View class="min-h-11 flex-row items-center px-2 gap-2"><Button testID="model-variant-back" class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('header.actions.backAria')} onPress={props.onBack}><Icon name="arrow-left" size={18} /></Button><NativeModelLogo providerID={props.entry.providerID} modelID={props.entry.modelID} size={16} /><Text class="flex-1 text-sm text-foreground" style={{ numberOfLines: 1 }}>{modelLabel(props.entry)}</Text><Button testID="model-picker-close" class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('mobile.surface.closeAria')} onPress={props.onClose}><Icon name="close" size={18} /></Button></View>;
}
