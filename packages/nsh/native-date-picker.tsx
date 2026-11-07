import { nativeComponent, platform, Scroll, signal, View } from 'nsh';
import { Button, DatePicker, type DatePickerProps } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { Icon } from './Icon';
import { t } from './i18n';

const Calendar = nativeComponent<{ value: string }, { change: { value: string } }>('yuri.datePicker', { props: ['value'], events: ['change'] });

export function NativeDatePicker(props: DatePickerProps) {
  if (platform.os !== 'ios') return <DatePicker {...props} />;
  const open = signal(false);
  return <View><Button testID={props.testID} disabled={props.disabled} accessibilityLabel={props.accessibilityLabel} onPress={() => open.set(true)}>{props.trigger}</Button>
    <NativeSheet open={open()} closeOnSwipe detents={[.55, 1]} onOpenChange={event => open.set(event.open)} popupClass="bg-background p-4 gap-2">
      <View class="flex-row justify-end"><Button class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('mobile.surface.closeAria')} onPress={() => open.set(false)}><Icon name="close" size={20} /></Button></View>
      <Scroll class="flex-1"><Calendar value={typeof props.value === 'string' ? props.value : ''} style={{ height: 360 }} onChange={event => { props.onChange?.({ value: event.value }); open.set(false); }} /></Scroll>
    </NativeSheet>
  </View>;
}
