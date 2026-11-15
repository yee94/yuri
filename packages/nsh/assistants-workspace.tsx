import { colorScheme, computed, Image, platform, signal, Text, token, View, windowSize, type JSX } from 'nsh';
import pattern from '../ui/src/assets/assistant-wallpaper/telegram-pattern.svg';
import { nativeAgentPaletteTokens } from './appearance';
import { assistantPanelColor } from './assistants-presentation';
import { AssistantAvatar } from './assistants-avatar-live';
import { t } from './i18n';
import { text, type Row } from './model';

export const assistantPanelStyle = () => ({ backgroundColor: assistantPanelColor(String(token('background')), colorScheme() === 'dark') });
export const assistantPanelShadow = () => colorScheme() === 'dark' ? 'none' : `0 4px 12px ${String(token('foreground')).slice(0, 7)}1f`;

/** Viewport-only tiles: no scroll listener, network request or animation clock. */
export function AssistantWallpaper() {
  const size = signal(windowSize());
  const tiles = computed(() => {
    const columns = Math.ceil(size().width / 504) + 1, rows = Math.ceil(size().height / 1036);
    return Array.from({ length: columns * rows }, (_, index) => ({ x: (size().width - columns * 504) / 2 + index % columns * 504, y: Math.floor(index / columns) * 1036 }));
  });
  const layer = (color: string, mask: string) => <View class="absolute inset-0" style={{ maskImage: mask }}>
    <Each of={tiles()}>{tile => <Image src={pattern} accessible={false} style={{ position: 'absolute', left: tile().x, top: tile().y, width: 504, height: 1036, objectFit: 'fill', tintColor: color }} />}</Each>
  </View>;
  return <View testID="assistant-wallpaper" class="absolute inset-0" accessible={false} accessibilityElementsHidden style={{ overflow: 'hidden', pointerEvents: 'none', opacity: .06 }} onLayout={event => {
    const next = event.bounds.size;
    if (next.width > 0 && next.height > 0 && (next.width !== size().width || next.height !== size().height)) size.set(next);
  }}>
    {layer(String(token('muted-foreground')), 'linear-gradient(155deg, #000000, #00000000)')}
    {layer(nativeAgentPaletteTokens()['--primary-base'] || String(token('foreground')), 'linear-gradient(155deg, #00000000, #000000)')}
  </View>;
}

export function AssistantIdentity(props: { bot: Row; active: boolean; onPress: () => void }) {
  return <View testID="assistant-chat-identity" class="items-center gap-0.5" role="button" accessibilityLabel={t('assistants.menu.edit')} onPress={props.onPress} style={{ maxWidth: '70%', alignSelf: 'center' }}>
    <View style={{ filter: colorScheme() === 'dark' ? `drop-shadow(0 3px 5px ${String(token('background')).slice(0, 7)}99)` : undefined }}><AssistantAvatar bot={props.bot} size={56} active={props.active} /></View>
    <View class="rounded-full px-3.5 py-1" style={{ ...assistantPanelStyle(), maxWidth: '100%', borderWidth: 1, borderColor: String(token('border')) }}>
      <Text class="text-sm font-medium text-foreground" style={{ numberOfLines: 1, textOverflow: 'ellipsis' }}>{text(props.bot.name)}</Text>
    </View>
  </View>;
}

export function AssistantTranscriptRow(props: { enabled: boolean; outgoing: boolean; bot: Row; active: boolean; children?: JSX.Element }) {
  return <If when={props.enabled} else={props.children}><View class="flex-row items-end gap-3" style={{ paddingHorizontal: 8 }}>
    <If when={!props.outgoing}><View style={{ width: 32, flexShrink: 0 }}><AssistantAvatar bot={props.bot} size={32} active={props.active} /></View></If>
    <View class="flex-1 min-w-0" style={props.outgoing ? { marginLeft: 44 } : undefined}>{props.children}</View>
  </View></If>;
}

export function AssistantHeaderScrim(props: { children?: JSX.Element }) {
  const scrimColor = String(token('background')).slice(0, 7);
  return <View class="absolute top-0 left-0 right-0" style={{ zIndex: 2, paddingTop: 8, paddingBottom: 48, pointerEvents: 'box-none' }}>
    <View class="absolute inset-0" style={{ pointerEvents: 'none', ...(platform.os === 'android'
      ? { backgroundImage: `linear-gradient(to bottom, ${scrimColor}f2, ${scrimColor}cc 35%, ${scrimColor}73 65%, ${scrimColor}00)` }
      : { backgroundColor: String(token('background')), maskImage: 'linear-gradient(to bottom, #000000f2, #000000cc 35%, #00000073 65%, #00000000)' }) }} />
    {props.children}
  </View>;
}
