import { Text, View } from 'nsh';
import { Button, Sheet } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { ActionRow, alpha, fontSize } from '../core/ui';
import type { IconName } from '../core/Icon';

export type SheetItem = {
  id: string;
  icon: IconName;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** A gap before it: the delete/close group of the Web sheet. */
  separated?: boolean;
};

/** The system bottom sheet the Web phone uses for row commands (`MobileActionSheet`). */
export function ActionsSheet(props: {
  open: () => boolean;
  title: () => string;
  items: () => SheetItem[];
  onOpenChange: (open: boolean) => void;
}) {
  const groups = () => {
    const out: SheetItem[][] = [];
    for (const item of props.items()) {
      const last = out[out.length - 1];
      if (!last || item.separated) out.push([item]);
      else last.push(item);
    }
    return out;
  };
  return (
    <Sheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => props.onOpenChange(event.open)}
      popupStyle={{ backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 }}
      backdropStyle={{ backgroundColor: alpha('#000000', 0.32) }}
    >
      <View style={{ paddingHorizontal: 12, paddingTop: 16, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <Text
          style={{
            paddingHorizontal: 8,
            paddingBottom: 10,
            fontSize: fontSize.entityTitle,
            fontWeight: '600',
            color: colors.foreground(),
            numberOfLines: 1,
          }}
        >
          {props.title()}
        </Text>
        <View style={{ gap: 18 }}>
          <Each of={groups()} key={(group) => group[0]?.id ?? 'group'}>
            {(group) => (
              <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.9) }}>
                <Each of={group()} key={(item) => item.id}>
                  {(item) => (
                    <ActionRow
                      icon={item().icon}
                      label={item().label}
                      destructive={item().destructive}
                      disabled={item().disabled}
                      spinning={item().busy}
                      onPress={() => {
                        props.onOpenChange(false);
                        item().onPress();
                      }}
                    />
                  )}
                </Each>
              </View>
            )}
          </Each>
          <Button
            onPress={() => props.onOpenChange(false)}
            style={{
              minHeight: 52,
              borderRadius: radius.inset,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: alpha(colors.muted(), 0.9),
            }}
          >
            <Text style={{ fontSize: 16, color: colors.foreground() }}>{t('gitView.common.cancel')}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
