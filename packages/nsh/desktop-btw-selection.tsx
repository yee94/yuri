import { computed, Text, View } from 'nsh';
import { getProviderModelDisplayName } from '../ui/src/lib/modelDisplay';
import { nativeChatTextStyle } from './appearance';
import { NativeModelLogo } from './chat-identity';
import type { NativeBtwSelectionSlot } from './desktop-btw-panel';

export type NativeDesktopBtwSelectionProps = {
  slot: NativeBtwSelectionSlot;
  /** Already-resolved label for this exact snapshot, supplied by the main Chat's catalog owner. */
  label?: { providerID: string; modelID: string; label: string } | null;
  current?: () => boolean;
};

/** Web BtwComposer's readonly modelControl. No picker, Agent/variant label, catalog or mutation. */
export function NativeDesktopBtwSelection(props: NativeDesktopBtwSelectionProps) {
  const selection = computed(() => props.current?.() !== false && props.slot.current() ? props.slot.selection() : null);
  const label = computed(() => {
    const value = selection();
    if (!value?.providerID || !value.modelID) return '';
    const projected = props.label;
    const exact = projected?.providerID === value.providerID && projected.modelID === value.modelID;
    return (exact ? projected.label.trim() : '') || getProviderModelDisplayName(undefined, value.modelID);
  });
  // Pending retains the same readonly metadata as Web; there is no selection/open/write path to admit.
  return <If when={!!label()}>
    <View testID="btw-model-control" class="flex-row items-center gap-1.5 rounded-lg px-2.5 py-1" style={{ minWidth: 0, flexShrink: 1 }} accessibilityLabel={label()}>
      <NativeModelLogo providerID={selection()!.providerID} modelID={selection()!.modelID} size={16} />
      <Text testID="btw-model-label" class="text-foreground" style={{ ...nativeChatTextStyle('meta'), fontWeight: '500', minWidth: 0, flexShrink: 1, numberOfLines: 1 }}>{label()}</Text>
    </View>
  </If>;
}
