import { token, View, type JSX } from 'nsh';
import { Button, Input, type InputProps } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { nativeDensity } from './appearance';

/** Decoration only: the NSH Input still owns focus, selection, IME and editing. */
export function NativeSheetSearch(props: InputProps & { onClear: () => void; clearTestID?: string; registration?: JSX.Element }) {
  const inputProps: InputProps = {};
  for (const key of Object.keys(props)) {
    if (key === 'onClear' || key === 'clearTestID' || key === 'registration') continue;
    Object.defineProperty(inputProps, key, { enumerable: true, get: () => Reflect.get(props, key) });
  }
  return <View class="flex-row items-center rounded-2xl bg-secondary px-3 gap-2" style={{ minHeight: 50, paddingHorizontal: 12 * nativeDensity().scale, gap: 8 * nativeDensity().scale }}>
    <Icon name="search" size={18} color={token('muted-foreground')} />
    <Input {...inputProps} class={props.class ?? 'flex-1 bg-transparent text-foreground'} style={[{ minHeight: 50, fontSize: 17, placeholderColor: token('muted-foreground'), paddingHorizontal: 0, borderWidth: 0 }, props.style]}
      returnKeyType={props.returnKeyType ?? 'search'} autoCapitalize={props.autoCapitalize ?? 'none'} autoCorrect={props.autoCorrect ?? false} />
    {props.registration}
    <If when={props.value}><Button testID={props.clearTestID} class="items-center justify-center" style={{ width: 44, height: 44 }} accessibilityLabel={t('chat.modelControls.clearSearch')} onPress={props.onClear}><Icon name="close-circle" size={18} color={token('muted-foreground')} /></Button></If>
  </View>;
}
