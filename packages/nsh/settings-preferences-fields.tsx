import { effect, lifecycle, reduceMotion, signal, Text, View } from 'nsh';
import { Button, Radio, RadioGroup } from 'nsh/base';
import { t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { nativeDensity } from './appearance';

export type PreferenceChoiceField = Readonly<{
  key: string;
  title: I18nKey;
  options?: readonly Readonly<{ value: string; title: I18nKey }>[];
}>;

export function hasPreferenceChoicePresentation(key: string): boolean {
  return key === 'chatRenderMode' || key === 'messageStreamTransport' || key === 'diffLayoutPreference' || key === 'fileEditorKeymap';
}

/** Owns the section label and material; mount directly inside SettingsTarget,
 * without SettingsGroup/SettingsChoice around it. Values remain owner authority. */
export function SettingsPreferenceChoiceField(props: {
  field: PreferenceChoiceField;
  value: unknown;
  disabled?: boolean;
  active?: boolean;
  previewVisible?: boolean;
  onChange: (value: string) => void;
}) {
  const previewTick = signal(0);
  const animatePreview = () => props.field.key === 'chatRenderMode' && props.active === true && props.previewVisible !== false && lifecycle() === 'active' && !reduceMotion();
  effect(() => {
    if (!animatePreview()) return;
    let current = true;
    const timer = setInterval(() => {
      if (current && animatePreview()) previewTick.set((previewTick() + 1) % 24);
    }, 420);
    return () => { current = false; clearInterval(timer); };
  });
  const choose = (value: string) => {
    if (!props.disabled && props.field.options?.some(option => option.value === value)) props.onChange(value);
  };
  const description = () => {
    const selected = props.field.options?.find(option => option.value === props.value);
    if (selected?.value === 'auto') return t('settings.yuri.visual.option.messageTransport.auto.description');
    if (selected?.value === 'ws') return t('settings.yuri.visual.option.messageTransport.ws.description');
    if (selected?.value === 'sse') return t('settings.yuri.visual.option.messageTransport.sse.description');
    return '';
  };
  return <View testID={`settings-preference-${props.field.key}`} class="gap-2" style={nativeDensity().settings.section}>
    <Text class="text-xs text-muted-foreground px-2" style={nativeDensity().settings.choiceLabel}>{t(props.field.title)}</Text>
    <If when={props.field.key === 'fileEditorKeymap'}>
      <View accessible={false} role="radiogroup" accessibilityLabel={t(props.field.title)}>
      <RadioGroup class="flex-row flex-wrap rounded-2xl bg-card" style={nativeDensity().settings.chips}>
        <Each of={props.field.options ?? []}>{option => <Radio
          testID={`settings-preference-fileEditorKeymap-${option().value}`}
          checked={props.value === option().value} disabled={props.disabled}
          accessibilityLabel={t(option().title)}
          class="min-h-13 px-3.5 py-3 flex-row items-center gap-2 active:bg-accent focus:bg-accent disabled:opacity-40"
          style={nativeDensity().settings.radio}
          onChange={() => choose(option().value)}>
          <View class={props.value === option().value ? 'size-3.5 rounded-full border border-primary bg-primary items-center justify-center' : 'size-3.5 rounded-full border border-border items-center justify-center'}>
            <If when={props.value === option().value}><View class="size-1 rounded-full bg-primary-foreground" /></If>
          </View>
          <Text class={props.value === option().value ? 'text-sm text-foreground' : 'text-sm text-muted-foreground'}>{t(option().title)}</Text>
        </Radio>}</Each>
      </RadioGroup>
      </View>
    </If>
    <If when={props.field.key === 'chatRenderMode'}>
      <View accessible={false} role="radiogroup" accessibilityLabel={t('settings.yuri.visual.section.chatRenderModeAria')} class="gap-3" style={nativeDensity().settings.options}>
        <Each of={props.field.options ?? []}>{option => <Button
          testID={`settings-preference-chatRenderMode-${option().value}`}
          role="radio" selected={props.value === option().value}
          accessibilityLabel={t(option().title)} disabled={props.disabled}
          class="gap-1 rounded-lg border border-border p-3 selected:border-primary selected:bg-accent active:bg-accent focus:bg-accent disabled:opacity-40"
          style={nativeDensity().settings.option}
          onPress={() => choose(option().value)}>
          <Text class={props.value === option().value ? 'text-sm font-semibold text-foreground' : 'text-sm font-semibold text-muted-foreground'}>{t(option().title)}</Text>
           <PreferenceRenderPreview mode={option().value} phase={reduceMotion() ? 9 : previewTick() % 12} animate={animatePreview()} />
        </Button>}</Each>
      </View>
    </If>
    <If when={props.field.key === 'messageStreamTransport'}>
      <View class="rounded-2xl bg-card px-3.5 py-3 gap-2" style={nativeDensity().settings.transport}>
        <View accessible={false} role="radiogroup" accessibilityLabel={t(props.field.title)} class="flex-row flex-wrap gap-1" style={nativeDensity().settings.chips}>
          <Each of={props.field.options ?? []}>{option => <Button
            testID={`settings-preference-messageStreamTransport-${option().value}`}
            role="radio" selected={props.value === option().value}
            accessibilityLabel={t(option().title)} disabled={props.disabled}
            class="min-h-9 px-2 rounded-lg items-center justify-center selected:bg-accent active:bg-accent focus:bg-accent disabled:opacity-40"
            style={nativeDensity().settings.chip}
            onPress={() => choose(option().value)}><Text class="text-sm text-foreground">{t(option().title)}</Text></Button>}</Each>
        </View>
        <If when={!!description()}><Text testID="settings-preference-messageStreamTransport-description" class="text-xs text-muted-foreground">{description()}</Text></If>
      </View>
    </If>
    <If when={props.field.key === 'diffLayoutPreference'}>
      <RadioGroup class="rounded-2xl bg-card">
        <Each of={props.field.options ?? []}>{(option, index) => <Radio
          testID={`settings-preference-diffLayoutPreference-${option().value}`}
          checked={props.value === option().value} disabled={props.disabled}
          accessibilityLabel={t('settings.yuri.visual.field.diffLayoutAria', { option: t(option().title) })}
          class="min-h-13 px-3.5 py-3 flex-row items-center gap-2 border-border active:bg-accent focus:bg-accent disabled:opacity-40"
          style={{ ...nativeDensity().settings.radio, borderTopWidth: index() > 0 ? 1 : 0 }}
          onChange={() => choose(option().value)}>
          <View class={props.value === option().value ? 'size-3.5 rounded-full border border-primary bg-primary items-center justify-center' : 'size-3.5 rounded-full border border-border items-center justify-center'}>
            <If when={props.value === option().value}><View class="size-1 rounded-full bg-primary-foreground" /></If>
          </View>
          <Text class={props.value === option().value ? 'flex-1 text-sm text-foreground' : 'flex-1 text-sm text-muted-foreground'}>{t(option().title)}</Text>
        </Radio>}</Each>
      </RadioGroup>
    </If>
  </View>;
}

/** Web's exact row phases, with native transitions and persistent row geometry.
 * The field owns one clock shared by both cards, never a timer per row. */
function PreferenceRenderPreview(props: { mode: string; phase: number; animate: boolean }) {
  const progress = (index: number) => {
    if (props.mode !== 'live') return 92;
    const elapsed = props.phase - index * 3;
    return elapsed <= 0 ? 0 : elapsed === 1 ? 42 : elapsed === 2 ? 68 : 92;
  };
  const visible = (index: number) => props.mode === 'live' ? progress(index) > 0 : props.phase >= (index + 1) * 3;
  return <View testID={`settings-preference-preview-${props.mode}`} accessible={false} class="mt-2 rounded-md border border-border bg-muted p-2 gap-1.5" style={nativeDensity().settings.preview}>
    <Each of={[0, 1, 2]}>{index => <View testID={`settings-preference-preview-${props.mode}-row-${index()}`} class="flex-row items-center gap-1.5" style={{ height: 8, opacity: visible(index()) ? 1 : 0, transform: [{ translateY: visible(index()) ? 0 : 4 }], transitionProperty: 'opacity, transform', transitionDuration: props.animate ? 300 : 0, transitionTimingFunction: 'ease' }}>
      <View class="size-2 rounded-full bg-muted-foreground opacity-55" />
      <View class="flex-1"><View testID={`settings-preference-preview-${props.mode}-line-${index()}`} class="h-1.5 rounded bg-muted-foreground opacity-30" style={{ width: `${progress(index())}%`, transitionProperty: 'width', transitionDuration: props.animate ? 300 : 0, transitionTimingFunction: 'ease' }} /></View>
    </View>}</Each>
  </View>;
}
