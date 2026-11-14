import { Text, View } from 'nsh';
import { Switch } from 'nsh/base';
import { colors, radius } from '../core/theme';
import { Icon, type IconName } from '../core/Icon';
import { alpha, fontSize } from '../core/ui';
import type { JSX } from 'nsh';

/** Web `MobileSettingsGroup`: a quiet label over one grouped card. */
export function Group(props: { label: string; children?: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ paddingHorizontal: 8, fontSize: 12, lineHeight: 16, color: colors.mutedForeground() }}>
        {props.label}
      </Text>
      <View
        style={{
          borderRadius: radius.inset,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: colors.border(),
          backgroundColor: alpha(colors.muted(), 0.55),
        }}
      >
        {props.children}
      </View>
    </View>
  );
}

type Readable<T> = T | (() => T);

const read = <T,>(value: Readable<T> | undefined): T | undefined =>
  typeof value === 'function' ? (value as () => T)() : value;

/** Web `MobileSettingsRow`: the label on the leading edge, its value trailing. */
export function Row(props: {
  label: Readable<string>;
  value?: Readable<string>;
  description?: Readable<string>;
  icon?: Readable<IconName>;
  testID?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  children?: JSX.Element;
}) {
  return (
    <View
      testID={props.testID}
      role={props.onPress ? 'button' : undefined}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      activeStyle={props.onPress ? { backgroundColor: alpha(colors.mutedForeground(), 0.06) } : undefined}
      style={{
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderTopWidth: 0.5,
        borderTopColor: colors.border(),
      }}
    >
      <If when={!!read(props.icon)}>
        <Icon name={read(props.icon) ?? 'folder'} size={17} tone="muted" />
      </If>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ fontSize: fontSize.label, color: colors.foreground(), numberOfLines: 1 }}>{read(props.label) ?? ''}</Text>
        <If when={!!read(props.description)}>
          <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), numberOfLines: 2 }}>
            {read(props.description) ?? ''}
          </Text>
        </If>
      </View>
      {props.children}
      <If when={!!read(props.value)}>
        <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
          {read(props.value) ?? ''}
        </Text>
      </If>
      <If when={!!props.onPress}>
        <Icon name="arrow-right-s" size={16} tone="muted" />
      </If>
    </View>
  );
}

/** A row that flips a Host setting; the switch is the system's own control. */
export function SwitchRow(props: { label: string; description?: string; checked: () => boolean; onChange: (value: boolean) => void }) {
  return (
    <Row
      label={props.label}
      description={props.description}
      onPress={() => props.onChange(!props.checked())}
    >
      <Switch
        checked={props.checked()}
        onChange={(event) => props.onChange(event.checked)}
        trackStyle={{
          width: 51,
          height: 31,
          borderRadius: 16,
          padding: 2,
          justifyContent: 'center',
          backgroundColor: props.checked() ? '#34c759' : alpha(colors.mutedForeground(), 0.3),
        }}
        thumbStyle={{
          width: 27,
          height: 27,
          borderRadius: 14,
          backgroundColor: '#ffffff',
          transform: [{ translateX: props.checked() ? 20 : 0 }],
        }}
      />
    </Row>
  );
}

export function Empty(props: { text: string }) {
  return (
    <View style={{ paddingVertical: 18, paddingHorizontal: 14 }}>
      <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), textAlign: 'center' }}>
        {props.text}
      </Text>
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ paddingVertical: 18, alignItems: 'center' }}>
      <Icon name="loader-4" size={18} tone="muted" />
    </View>
  );
}
