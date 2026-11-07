import { effect, Image, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { assistantAvatarSvg } from '../ui/src/lib/assistant-avatar/engine';
import { AVATAR_COLORS, AVATAR_PICKER_SHAPES, createRandomAssistantAvatarSeed, encodeAssistantAvatar, resolveAssistantAvatar } from '../ui/src/lib/assistant-avatar/recipe';
import { t } from './i18n';
import { id } from './model';
import { Icon } from './Icon';

export function AssistantAvatarPicker(props: { seed: string; disabled: boolean; onChange: (value: string) => void }) {
  const recipe = () => resolveAssistantAvatar(props.seed);
  const thumbnails = signal<Record<string, string>>({});
  effect(() => {
    const saved = resolveAssistantAvatar(props.seed);
    const work = [
      ...AVATAR_PICKER_SHAPES.map(shape => ({ key: `shape-${shape}`, seed: encodeAssistantAvatar({ ...saved, shape }) })),
      ...AVATAR_COLORS.map(color => ({ key: `color-${color}`, seed: encodeAssistantAvatar({ ...saved, color }) })),
    ];
    let alive = true, index = 0, timer: ReturnType<typeof setTimeout> | undefined;
    thumbnails.set({});
    const next = () => {
      timer = setTimeout(() => {
        if (!alive || index >= work.length) return;
        const item = work[index++];
        const uri = 'data:image/svg+xml,' + encodeURIComponent(assistantAvatarSvg(item.seed));
        if (!alive) return;
        thumbnails.set({ ...thumbnails(), [item.key]: uri });
        if (index < work.length) next();
      }, 16);
    };
    next();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  });
  const image = (seed: string, size: number) => <Image src={'data:image/svg+xml,' + encodeURIComponent(assistantAvatarSvg(seed))} style={{ width: size, height: size }} />;
  return <View class="bg-card rounded-3xl p-4 gap-4">
    <View class="flex-row items-center gap-3">
      {image(props.seed, 44)}
      <Text class="flex-1 text-foreground">{t('assistants.avatar.title')}</Text>
      <Button class="min-h-11 px-3 flex-row gap-2 items-center rounded-xl bg-secondary" disabled={props.disabled} onPress={() => props.onChange(createRandomAssistantAvatarSeed(id().replace(/_/g, '-')))}><Icon name="refresh" size={16} /><Text class="text-muted-foreground">{t('assistants.settings.randomAvatar')}</Text></Button>
    </View>
    <View class="flex-row flex-wrap gap-3 justify-center">
      <Each of={AVATAR_PICKER_SHAPES}>{shape => <Button class="w-14 h-14 rounded-xl items-center justify-center selected:bg-accent" selected={recipe().shape === shape()} disabled={props.disabled} accessibilityLabel={t(`assistants.avatar.shape.${shape()}`)} onPress={() => props.onChange(encodeAssistantAvatar({ ...recipe(), shape: shape() }))}><If when={!!thumbnails()[`shape-${shape()}`]}><Image src={thumbnails()[`shape-${shape()}`]} style={{ width: 32, height: 32 }} /></If></Button>}</Each>
    </View>
    <View class="flex-row flex-wrap gap-2 justify-center">
      <Each of={AVATAR_COLORS}>{color => <Button class="w-10 h-10 rounded-full items-center justify-center selected:bg-accent" disabled={props.disabled} selected={recipe().color === color()} accessibilityLabel={t(`assistants.avatar.color.${color()}`)} onPress={() => props.onChange(encodeAssistantAvatar({ ...recipe(), color: color() }))}><If when={!!thumbnails()[`color-${color()}`]}><Image src={thumbnails()[`color-${color()}`]} style={{ width: 24, height: 24 }} /></If></Button>}</Each>
    </View>
  </View>;
}
