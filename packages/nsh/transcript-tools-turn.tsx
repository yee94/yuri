import { computed, effect, signal, Text, View } from 'nsh';
import { record, list, text, type Message } from './model';
import { query } from './runtime';
import { createPageOperations } from './page-operations';
import { NativeAgentAvatar, NativeModelLogo, nativeAgentAccent } from './chat-identity';
import { formatEffortLabel } from '../ui/src/components/chat/mobileControlsUtils';
import { Icon } from './Icon';
import { nativeChatTextStyle } from './appearance';
import { nativeTurnErrorPresentation, nativeTurnModelName } from './transcript-tools-turn-model';
import type { NativeBodyRow } from './transcript-body-model';
import { t } from './i18n';

/** One catalog read per page; it labels historical IDs, never supplies their identity. */
export function createNativeTurnModelNames(current: () => boolean, directory: string) {
  const operations = createPageOperations(current);
  const catalog = signal<ReturnType<typeof list>>([]);
  effect(() => {
    const lane = operations.operation();
    if (!lane?.current()) return;
    let cancelled = false;
    void lane.request(`/api/config/catalog/providers?${query(directory)}`).then(value => {
      const providers = record(value).providers;
      if (!Array.isArray(providers)) return;
      if (!cancelled && lane.current()) catalog.set(list(providers));
    }).catch(() => { /* A missing catalog label never replaces historical identity. */ });
    return () => { cancelled = true; };
  });
  return (message: Message) => nativeTurnModelName(message, catalog());
}

export function NativeTurnHeader(props: { message: Message; modelName: string; identityKey?: string }) {
  let retained: { key: string; modelID?: string; providerID?: string; agent?: string; name?: string } | undefined;
  const identity = computed(() => {
    const key = props.identityKey ?? props.message.id;
    const previous = retained?.key === key ? retained : undefined;
    retained = { key, modelID: props.message.modelID ?? previous?.modelID, providerID: props.message.providerID ?? previous?.providerID,
      agent: props.message.agent ?? previous?.agent, name: props.modelName || previous?.name };
    return retained;
  });
  const variant = () => props.message.variant && props.message.variant.trim().toLowerCase() !== 'default' ? formatEffortLabel(props.message.variant) : '';
  const modelStyle = () => { const style = nativeChatTextStyle('uiHeader'); return { ...style, lineHeight: Number(style.fontSize) * 1.25, letterSpacing: -0.3 }; };
  return <View testID={`turn-header-${props.message.id}`} class="flex-row items-center gap-2 pb-1">
    <NativeModelLogo modelID={identity().modelID} providerID={identity().providerID} size={16} />
    <Text class="font-semibold text-foreground" style={{ ...modelStyle(), flexShrink: 1, minWidth: 0, numberOfLines: 1 }}>{identity().name || t('commandPalette.message.assistant')}</Text>
    <If when={!!variant()}><Text class="text-xs text-muted-foreground">{variant()}</Text></If>
    <If when={!!identity().agent}><View class="flex-row items-center gap-1 px-1 rounded" style={{ backgroundColor: nativeAgentAccent(identity().agent) + '20' }}>
      <NativeAgentAvatar name={identity().agent} size={10} />
      <Text class="text-xs" style={{ color: nativeAgentAccent(identity().agent), fontSize: 10 }}>{identity().agent ? identity().agent!.charAt(0).toUpperCase() + identity().agent!.slice(1) : ''}</Text>
    </View></If>
  </View>;
}

export function NativeTurnMetrics(props: { tps?: string; duration?: string }) {
  return <View class="flex-row items-center gap-2">
    <If when={!!props.tps}><View class="flex-row items-center gap-1"><Icon name="pulse" size={12} /><Text class="text-xs text-muted-foreground">{props.tps}</Text></View></If>
    <If when={!!props.duration}><View class="flex-row items-center gap-1"><Icon name="hourglass" size={12} /><Text class="text-xs text-muted-foreground">{props.duration}</Text></View></If>
  </View>;
}

export function NativeTurnError(props: { row: NativeBodyRow }) {
  const presentation = computed(() => nativeTurnErrorPresentation(props.row, key => t(key)));
  return <If when={!!presentation()}><View class="gap-1">
    <View class="flex-row items-center gap-2"><Icon name={presentation()!.icon} size={14} /><Text class={presentation()!.variant === 'error' ? 'text-destructive' : 'text-muted-foreground'} style={nativeChatTextStyle('meta')}>{presentation()!.text}</Text></View>
    <If when={!!presentation()?.detail}><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{presentation()!.detail}</Text></If>
    <If when={!!presentation()?.rawMessage}><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{presentation()!.rawMessage}</Text></If>
  </View></If>;
}
