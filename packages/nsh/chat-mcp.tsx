import { cleanup, colorScheme, effect, Scroll, signal, Text, token, untracked, View } from 'nsh';
import { Button, Switch } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { Icon } from './Icon';
import { t } from './i18n';
import { createPageOperations } from './page-operations';
import { createChatMcpModel, type ChatMcpStatus } from './chat-mcp-model';
import { nativeAppearance } from './appearance';

function statusLabel(value: ChatMcpStatus | undefined) {
  if (!value) return t('mcpDropdown.status.unknown');
  if (value.status === 'connected') return t('mcpDropdown.status.connected');
  if (value.status === 'failed') return t('mcpDropdown.status.failed', { error: value.error || t('mcpDropdown.status.unknownError') });
  if (value.status === 'needs_auth') return t('mcpDropdown.status.needsAuth');
  if (value.status === 'needs_client_registration') return t('mcpDropdown.status.needsRegistration', { error: value.error || '' });
  return value.status;
}

export function NativeChatMcp(props: { directory: string; active: boolean; open: boolean; onOpenChange: (open: boolean) => void; onCreate: () => void }) {
  const interactive = signal(false), createAfterClose = signal(false);
  const operations = createPageOperations(() => props.active && props.open && interactive());
  const model = createChatMcpModel(props.directory, value => state.set(value));
  const state = signal(model.snapshot());
  cleanup(model.dispose);
  effect(() => {
    const lane = operations.operation();
    untracked(() => { model.replaceLane(lane); if (lane) void model.refresh(); });
  });
  const disabled = (name: string) => !operations.current() || !state().statusReady || state().loading || state().busy.includes(name) || state().unconfirmed.includes(name) || !state().statuses[name];
  const tone = (value: ChatMcpStatus | undefined) => {
    const colors = nativeAppearance.current()?.webTheme?.[colorScheme()].colors.status;
    if (value?.status === 'connected') return token('success');
    if (value?.status === 'failed') return token('destructive');
    if (value?.status === 'needs_auth' || value?.status === 'needs_client_registration') return colors?.warning ?? token('muted-foreground');
    return token('muted-foreground');
  };
  return <NativeSheet testID="chat-mcp-sheet" open={props.open} detents={[.72, .98]} initialDetent={1} onOpen={() => interactive.set(true)} onOpenChange={event => props.onOpenChange(event.open)} onClose={() => {
    interactive.set(false);
    const create = createAfterClose(); createAfterClose.set(false);
    if (create && props.active && operations.displayCurrent()) props.onCreate();
  }} popupClass="bg-background pb-4 gap-2">
    <View class="flex-row items-center gap-2 px-4">
      <Text class="flex-1 text-base font-semibold text-foreground">{t('mcpDropdown.title')}</Text>
      <Button testID="chat-mcp-create" class="size-11 items-center justify-center" disabled={!operations.current()} accessibilityLabel={t('settings.mcp.sidebar.actions.addServerTitle')} onPress={() => { if (operations.current()) { createAfterClose.set(true); props.onOpenChange(false); } }}><Icon name="add" size={20} /></Button>
      <Button testID="chat-mcp-refresh" class="size-11 items-center justify-center disabled:opacity-40" disabled={!operations.current() || state().loading} accessibilityLabel={t('mcpDropdown.actions.refreshAria')} onPress={() => { void model.refresh(); }}><Icon name="refresh" size={20} /></Button>
      <Button testID="chat-mcp-close" class="size-11 items-center justify-center" accessibilityLabel={t('mobile.surface.closeAria')} onPress={() => props.onOpenChange(false)}><Icon name="close" size={20} /></Button>
    </View>
    <If when={state().loading}><Text class="text-sm text-muted-foreground px-4">{t('common.loading')}</Text></If>
    <Each of={state().errors}>{error => <Text role="alert" class="text-sm text-destructive px-4">{error()}</Text>}</Each>
    <If when={state().unconfirmed.length > 0}><Text testID="chat-mcp-unconfirmed" role="alert" class="text-sm text-muted-foreground px-4">{t('mcpDropdown.status.unconfirmed')}</Text></If>
    <Scroll class="flex-1" contentClass="gap-1 py-3">
      <Each of={state().names}>{name => <View testID={`chat-mcp-row-${name()}`} class="flex-row items-center gap-2 px-4 py-3 rounded-lg">
        <View accessible accessibilityLabel={statusLabel(state().statuses[name()])} class="rounded-full" style={{ width: 10, height: 10, backgroundColor: tone(state().statuses[name()]) }} />
        <Text class="flex-1 min-w-0 text-foreground font-medium" style={{ fontSize: 17, lineHeight: 24, numberOfLines: 1 }}>{name()}</Text>
        <Switch testID={`chat-mcp-toggle-${name()}`} checked={state().statuses[name()]?.status === 'connected'} disabled={disabled(name())} accessibilityLabel={`${name()} · ${statusLabel(state().statuses[name()])}`} onChange={event => { void model.toggle(name(), event.checked); }} trackClass="w-11 rounded-full bg-secondary p-0.5 disabled:opacity-40" trackStyle={{ backgroundColor: state().statuses[name()]?.status === 'connected' ? nativeAppearance.current()?.webTheme?.[colorScheme()].colors.status.info ?? token('ring') : token('secondary') }} thumbClass="size-5 rounded-full bg-background checked:translate-x-5" />
      </View>}</Each>
      <If when={state().ready && !state().loading && !state().errors.length && !state().names.length}><Text testID="chat-mcp-empty" class="text-sm text-muted-foreground text-center px-4 py-5">{t('mcpDropdown.empty.configureInConfig')}</Text></If>
    </Scroll>
  </NativeSheet>;
}
