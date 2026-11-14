import { Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { colors, radius } from './theme';
import { alpha } from './ui';
import { dismissToast, toasts } from './toast';

/** The floating undo toast (`sessionMutationUndo`): newest nearest the content edge. */
export function ToastHost(props: { inset?: number }) {
  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: (props.inset ?? 0) + 14,
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 8,
        pointerEvents: 'box-none',
      }}
    >
      <Each of={toasts()} key={(toast) => toast.id}>
        {(toast) => (
          <View
            testID="toast"
            accessibilityLabel={toast().message}
            style={{
              width: '100%',
              maxWidth: 452,
              minHeight: 48,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              borderRadius: radius.control,
              paddingLeft: 14,
              paddingRight: 6,
              paddingVertical: 6,
              backgroundColor: alpha(colors.foreground(), 0.94),
              backdropFilter: 'blur(18px) saturate(1.3)',
              boxShadow: '0 8px 24px -8px rgba(0,0,0,0.35)',
            }}
          >
            <Text style={{ flex: 1, fontSize: 13, color: colors.background(), numberOfLines: 2 }}>
              {toast().message}
            </Text>
            <If when={!!toast().actionLabel}>
              <Button
                testID={`toast-action-${toast().id}`}
                onPress={() => {
                  toast().onAction?.();
                  dismissToast(toast().id);
                }}
                style={{ minHeight: 36, paddingHorizontal: 12, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}
                activeStyle={{ backgroundColor: alpha(colors.background(), 0.14) }}
              >
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.background() }}>
                  {toast().actionLabel ?? ''}
                </Text>
              </Button>
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}
