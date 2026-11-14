import { Clipboard, Scroll, Text, View, signal } from 'nsh';
import { Button, Input, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius, space } from '../core/theme';
import {
  addConnection,
  appError,
  connection,
  connections,
  connecting,
  online,
  refreshCatalog,
  removeConnection,
  scanPairingLink,
  switchConnection,
} from '../core/store';
import { Icon } from '../core/Icon';
import { PrimaryButton, QuietButton, Surface, alpha, confirm, fontSize } from '../core/ui';
import { activeStack, tabBarInset } from './nav';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function field(defaults: { placeholder: string; value: () => string; set: (value: string) => void; masked?: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 14,
        minHeight: 46,
        borderRadius: radius.action,
        backgroundColor: colors.background(),
        borderWidth: 1,
        borderColor: colors.border(),
      }}
    >
      <Input
        value={defaults.value()}
        placeholder={defaults.placeholder}
        masked={defaults.masked ?? false}
        onChange={(event) => defaults.set(event.value)}
        style={{
          flex: 1,
          minHeight: 44,
          fontSize: 15,
          color: colors.foreground(),
          placeholderColor: colors.mutedForeground(),
        }}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

const groupTitle = (value: string) => (
  <Text style={{ fontSize: fontSize.entityMeta, fontWeight: '600', color: colors.mutedForeground() }}>{value}</Text>
);

const hero = () => (
  <View style={{ alignItems: 'center', gap: 10, paddingVertical: 18 }}>
    <View
      style={{
        width: 64,
        height: 64,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.foreground(),
      }}
    >
      <Icon name="sparkling" size={30} color={() => colors.background()} />
    </View>
    <Text style={{ fontSize: 24, fontWeight: '700', color: colors.foreground() }}>Yuri</Text>
    <Text style={{ fontSize: 14, color: colors.mutedForeground(), textAlign: 'center' }}>
      {t('mobile.connect.welcome.pairingHint')}
    </Text>
  </View>
);

/** Connection list, pairing link, QR scan and manual address (Web `Connect`). */
export function ConnectPage(props: { embedded?: boolean }) {
  const link = signal('');
  const url = signal('');
  const password = signal('');
  const token = signal('');
  const label = signal('');
  const advanced = signal(false);
  const pending = signal(false);
  const failure = signal('');

  const close = () => {
    if (props.embedded) return;
    activeStack().popToRoot();
  };

  const paste = async () => {
    try {
      const text = (await Clipboard.readText()).trim();
      if (text) link.set(text);
      else failure.set(t('mobile.connect.link.pasteFallback'));
    } catch {
      failure.set(t('mobile.connect.link.pasteFallback'));
    }
  };

  const scan = async () => {
    if (pending()) return;
    try {
      const value = (await scanPairingLink()).trim();
      if (!value) {
        failure.set(t('mobile.connect.scan.failed'));
        return;
      }
      link.set(value);
      failure.set('');
    } catch (error) {
      failure.set(errorText(error));
    }
  };

  const submit = async () => {
    if (pending() || connecting()) return;
    const pairingLink = link().trim();
    const address = url().trim();
    if (!pairingLink && !address) {
      failure.set(t('mobile.connect.error.urlRequired'));
      return;
    }
    pending.set(true);
    failure.set('');
    try {
      await addConnection({
        ...(pairingLink ? { pairingLink } : {}),
        ...(address ? { url: address } : {}),
        ...(password().trim() ? { password: password().trim() } : {}),
        ...(token().trim() ? { token: token().trim() } : {}),
        ...(label().trim() ? { label: label().trim() } : {}),
      });
      link.set('');
      url.set('');
      password.set('');
      token.set('');
      label.set('');
      void refreshCatalog();
      close();
    } catch (error) {
      failure.set(errorText(error));
    } finally {
      pending.set(false);
    }
  };

  const use = async (id: string) => {
    if (pending() || connection()?.id === id) return;
    pending.set(true);
    failure.set('');
    try {
      await switchConnection(id);
      void refreshCatalog();
      close();
    } catch (error) {
      failure.set(errorText(error));
    } finally {
      pending.set(false);
    }
  };

  const remove = async (id: string, label: string) => {
    const confirmed = await confirm({
      title: t('mobile.connect.history.remove'),
      message: t('mobile.connect.history.removeHint', { name: label }),
      confirmLabel: t('mobile.connect.history.remove'),
      cancelLabel: t('gitView.common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await removeConnection(id);
      void refreshCatalog();
    } catch (error) {
      failure.set(errorText(error));
    }
  };

  const body = (
    <Scroll
      class="flex-1"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentStyle={{ paddingHorizontal: space.pageInset, paddingTop: props.embedded ? 8 : 0, paddingBottom: 28 }}
    >
      <View style={{ width: '100%', maxWidth: 452, alignSelf: 'center', gap: space.pageGap }}>
        <If when={!connection()}>{hero()}</If>

        <Surface style={{ padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ flex: 1, fontSize: fontSize.body, fontWeight: '600', color: colors.foreground() }}>
              {t('mobile.connect.link.useLink')}
            </Text>
            <Button
              onPress={() => void paste()}
              style={{ minHeight: 32, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.muted(), alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontSize: 13, color: colors.foreground() }}>{t('mobile.connect.link.paste')}</Text>
            </Button>
            <Button
              onPress={() => void scan()}
              accessibilityLabel={t('mobile.connect.scanQr')}
              style={{ width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.muted() }}
            >
              <Icon name="scan-2" size={16} />
            </Button>
          </View>
          {field({ placeholder: t('mobile.connect.link.placeholder'), value: link, set: (value) => link.set(value) })}
          <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), lineHeight: 16 }}>
            {t('mobile.connect.link.help')}
          </Text>
        </Surface>

        <Button
          onPress={() => advanced.set(!advanced())}
          style={{ minHeight: 36, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 13, color: colors.mutedForeground() }}>{t('mobile.connect.advanced')}</Text>
        </Button>

        <If when={advanced()}>
          <Surface style={{ padding: 16, gap: 10 }}>
            {groupTitle(t('mobile.connect.url.label'))}
            {field({ placeholder: t('mobile.connect.url.placeholder'), value: url, set: (value) => url.set(value) })}
            {groupTitle(t('mobile.instances.label.label'))}
            {field({ placeholder: t('mobile.instances.label.placeholder'), value: label, set: (value) => label.set(value) })}
            {groupTitle(t('mobile.connect.password.label'))}
            {field({ placeholder: t('mobile.connect.password.placeholder'), value: password, set: (value) => password.set(value), masked: true })}
            {groupTitle(t('mobile.connect.token.label'))}
            {field({ placeholder: t('mobile.connect.token.placeholder'), value: token, set: (value) => token.set(value), masked: true })}
            <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), lineHeight: 16 }}>
              {t('mobile.connect.token.hint')}
            </Text>
          </Surface>
        </If>

        <PrimaryButton
          label={() => (pending() || connecting() ? t('mobile.connect.connecting') : t('mobile.connect.connectButton'))}
          busy={() => pending() || connecting()}
          onPress={() => void submit()}
        />

        <If when={!!failure()}>
          <Text style={{ fontSize: 13, color: colors.destructive(), paddingHorizontal: 4 }}>{failure()}</Text>
        </If>
        <If when={!failure() && !!appError()}>
          <Text style={{ fontSize: 13, color: colors.destructive(), paddingHorizontal: 4 }}>{appError()}</Text>
        </If>

        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 }}>
            <Text style={{ flex: 1, fontSize: fontSize.entityMeta, fontWeight: '600', color: colors.mutedForeground() }}>
              {t('mobile.connect.saved.title')}
            </Text>
            <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground() }}>
              {connection() ? (online() ? t('mobile.instances.status.connected') : t('mobile.instances.status.saved')) : ''}
            </Text>
          </View>
          <If when={connections().length === 0}>
            <Text style={{ fontSize: 13, color: colors.mutedForeground(), paddingHorizontal: 4 }}>
              {t('mobile.connect.saved.empty')}
            </Text>
          </If>
          <Each of={connections()} key={(entry) => entry.id}>
            {(entry) => {
              const row = () => entry();
              const active = () => connection()?.id === row().id;
              return (
                <Surface style={{ paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View
                    role="button"
                    onPress={() => void use(row().id)}
                    onLongPress={() => void remove(row().id, row().label)}
                    activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
                    style={{ flex: 1, minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pending() ? 0.6 : 1 }}
                  >
                    <Icon name={() => (active() ? 'server' : 'cloud')} size={18} tone={active() ? 'foreground' : 'muted'} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ fontSize: fontSize.entityTitle, fontWeight: '600', color: colors.foreground(), numberOfLines: 1 }}>
                        {row().label}
                      </Text>
                      <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                        {row().url}
                      </Text>
                    </View>
                    <If when={active()}>
                      <Icon name="check" size={16} color={() => colors.success()} />
                    </If>
                  </View>
                  <Button
                    onPress={() => void remove(row().id, row().label)}
                    accessibilityLabel={t('mobile.instances.deleteAria', { label: row().label })}
                    style={{ width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon name="delete-bin" size={16} tone="muted" />
                  </Button>
                </Surface>
              );
            }}
          </Each>
        </View>

        <If when={!props.embedded && !!connection()}>
          <QuietButton label={() => t('gitView.common.cancel')} onPress={close} />
        </If>
      </View>
    </Scroll>
  );

  if (props.embedded) {
    return (
      <View class="flex-1" style={{ backgroundColor: colors.background(), paddingTop: 'env(safe-area-inset-top)' }}>
        {body}
      </View>
    );
  }
  return (
    <NavPage title={t('mobile.connect.welcome.title')} class="flex-1" style={{ backgroundColor: colors.background() }} hidesBottomBarWhenPushed>
      <View class="flex-1" style={{ paddingBottom: tabBarInset() }}>
        {body}
      </View>
    </NavPage>
  );
}
