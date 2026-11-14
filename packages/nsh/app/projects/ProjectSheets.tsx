import { Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { t } from '../core/i18n';
import { colors } from '../core/theme';
import { alpha, NativeSheet, PrimaryButton, QuietButton } from '../core/ui';

const sheetPopup = { backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 } as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;
const body = { padding: 18, gap: 12, paddingBottom: 'env(safe-area-inset-bottom)' } as const;

const field = {
  minHeight: 48,
  borderRadius: 12,
  paddingHorizontal: 12,
  fontSize: 16,
  color: colors.foreground(),
  backgroundColor: colors.muted(),
  placeholderColor: colors.mutedForeground(),
} as const;

/** Session rename with Yuri's smart-title queue (Web `MobileOverlayPanel` rename). */
export function RenameSheet(props: {
  open: () => boolean;
  draft: () => string;
  setDraft: (value: string) => void;
  busy: () => boolean;
  onClose: () => void;
  onSave: () => void;
  onSmartTitle: () => void;
}) {
  return (
    <NativeSheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.onClose();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View style={body}>
        <Text style={{ fontSize: 18, fontWeight: '600', color: colors.foreground() }}>
          {t('sessions.sidebar.session.menu.rename')}
        </Text>
        <Input testID="rename-input" value={props.draft()} onChange={(event) => props.setDraft(event.value)} style={field} />
        <PrimaryButton
          label={() => t('sessions.sidebar.session.rename.save')}
          disabled={() => !props.draft().trim() || props.busy()}
          onPress={props.onSave}
        />
        <QuietButton label={() => t('sessions.sidebar.session.rename.smartTitle')} onPress={props.onSmartTitle} />
        <Button onPress={props.onClose} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 15, color: colors.mutedForeground() }}>{t('gitView.common.cancel')}</Text>
        </Button>
      </View>
    </NativeSheet>
  );
}

/** Add a project by its directory path. */
export function AddProjectSheet(props: {
  open: () => boolean;
  path: () => string;
  setPath: (value: string) => void;
  busy: () => boolean;
  error: () => string;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <NativeSheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.onClose();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View style={body}>
        <Text style={{ fontSize: 18, fontWeight: '600', color: colors.foreground() }}>
          {t('sessions.sidebar.header.actions.addProject')}
        </Text>
        <Input
          testID="add-project-input"
          value={props.path()}
          onChange={(event) => props.setPath(event.value)}
          placeholder={t('mobile.sessions.empty.noProjectsDescription')}
          autoCapitalize="none"
          autoCorrect={false}
          style={field}
        />
        <If when={!!props.error()}>
          <Text style={{ fontSize: 13, color: colors.destructive() }}>{props.error()}</Text>
        </If>
        <PrimaryButton
          label={() => t('sessions.sidebar.header.actions.addProject')}
          disabled={() => !props.path().trim() || props.busy()}
          busy={props.busy}
          onPress={props.onSubmit}
        />
        <Button onPress={props.onClose} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 15, color: colors.mutedForeground() }}>{t('gitView.common.cancel')}</Text>
        </Button>
      </View>
    </NativeSheet>
  );
}
