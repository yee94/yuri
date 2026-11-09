import { computed, List, Scroll, signal, Text, View, windowSize, type JSX, type ScrollRef, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import type { ProviderResult, QuotaProviderId } from '../ui/src/types/quota';
import { quotaProviders } from '../ui/src/lib/quota/providers';
import { Icon } from './Icon';
import { HeaderProviderLogo } from './chat-header-provider-logo';
import { t } from './i18n';
import { type SettingsChoice, SettingsGroup, SettingsInput, SettingsToggle, settingsAction } from './settings-controls';
import { NativeSelect } from './native-select';
import { publishSettingsPicker } from './desktop-settings-publisher';
import { SettingsTarget } from './settings-target';
import { createSettingsTargetNavigation } from './settings-search-core';
import { usageAccountRows, usageHeaderProviders, usageModelGroups, usageModelSelection, usageRefreshInterval, type createSettingsUsage, type UsageState } from './settings-usage-core';
import { desktopUsageReadFailed, desktopUsageRows, type DesktopUsageRow } from './desktop-usage-core';
import type { UsagePalette } from './settings-usage-palette';

function UsageChoice(props: Parameters<typeof SettingsChoice>[0]) {
  const open = signal(false);
  publishSettingsPicker(open);
  return <View class="min-h-13 flex-row items-center gap-3"><Text class="flex-1 text-sm text-foreground">{props.title}</Text><NativeSelect value={props.value} items={props.items} disabled={props.disabled} accessibilityLabel={props.title}
    popupClass="bg-card rounded-2xl p-3" listClass="bg-card" itemClass="min-h-8 px-3 py-2 text-foreground selected:bg-accent"
    onOpenChange={event => open.set(event.open)} onClose={() => open.set(false)} onChange={event => props.onChange(event.value ?? '')}
    trigger={<View testID={props.testID} class="min-h-7 px-2 flex-row items-center gap-2 rounded-lg hover:bg-accent"><Text class="text-sm text-foreground">{props.items.find(item => item.value === props.value)?.title ?? props.value}</Text><Icon name="arrow-down-s" size={14} /></View>} /></View>;
}

export type DesktopUsageWindowProps = {
  id: string; title: string; window: NonNullable<ProviderResult['usage']>['windows'][string];
  mode: 'usage' | 'remaining'; now: number; subtitle?: string; selected?: boolean; disabled?: boolean;
  predictions: boolean; palette: UsagePalette; onChange?: (enabled: boolean) => void;
};

/** Web's Usage workspace is not the entity split: preferences precede one scrolling results grid. */
export function DesktopUsage(props: {
  state: UsageState; owner: ReturnType<typeof createSettingsUsage>; active: boolean; target?: string;
  palette: UsagePalette; manualMagpie: boolean; magpieDraft: string | null;
  onManualMagpie: () => void; onMagpieDraft: (value: string) => void; onSaveMagpie: () => void;
  updated: (time: number | null | undefined) => string; intervalItems: { value: string; title: string }[];
  tone: (percent: number | null) => 'critical' | 'warn' | 'safe';
  window: (props: DesktopUsageWindowProps) => JSX.Element;
}) {
  const results = computed(() => props.state.results), settings = computed(() => props.state.settings);
  const display = computed(() => ({ ...settings(), ...props.state.draft }));
  const providerID = computed(() => props.state.selectedProviderId);
  const selected = computed(() => results().find(result => result.providerId === providerID()));
  const providers = computed(() => {
    const byID = new Map(results().map(result => [result.providerId, result]));
    return quotaProviders(results()).map(provider => {
      const result = byID.get(provider.id);
      const values = Object.values(result?.usage?.windows ?? {}).map(window => window.usedPercent).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      return { ...provider, configured: result?.configured === true, tone: props.tone(values.length ? Math.max(...values) : null) };
    });
  });
  const accounts = computed(() => selected() ? usageAccountRows(selected()!) : []);
  const groups = computed(() => selected() ? usageModelGroups(selected()!) : []);
  const collapsed = signal<Record<string, boolean>>({});
  const rows = computed<DesktopUsageRow[]>(() => desktopUsageRows(accounts(), groups(), collapsed()));
  const models = computed(() => new Set(selected() ? usageModelSelection(display(), selected()!) : []));
  const header = computed(() => usageHeaderProviders(display(), results()));
  const failed = computed(() => desktopUsageReadFailed(selected(), props.state.errors, providerID()));
  const disabled = () => !settings() || props.state.writing || props.state.refreshing || props.state.recovery || !props.active;
  const stacked = signal(false);
  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, () => props.active);
  const mode = () => settings()?.usageDisplayMode === 'remaining' ? 'remaining' as const : 'usage' as const;
  const select = (id: QuotaProviderId) => { if (props.active) props.owner.selectProvider(id, true); };
  const reveal = (node: ViewRef) => { if (props.active) void navigation.reveal(node); };
  return <Scroll testID="desktop-usage-scroll" ref={scroll} onScroll={navigation.onScroll} class="flex-1 min-w-0 min-h-0" contentClass="p-3 gap-5 pb-10" onLayout={event => { const width = event.bounds.size.width; if (width > 0) stacked.set(width <= 768); }}>
    <SettingsGroup title="">
      <View class="flex-row items-center gap-3"><Text class="flex-1 text-sm text-foreground">{t('settings.usage.sidebar.title')}</Text><Button testID="usage-refresh" class="size-7 items-center justify-center rounded-lg hover:bg-accent disabled:opacity-40" accessibilityLabel={t('settings.usage.sidebar.actions.refreshAria')} disabled={props.state.refreshing || props.state.writing || !props.active} onPress={() => { if (props.active) void props.owner.refresh(); }}><Icon name="refresh" size={14} /></Button></View>
      <SettingsToggle testID="usage-auto-refresh" title={t('settings.usage.sidebar.field.autoRefresh')} value={display().usageAutoRefresh === true} disabled={disabled()} onChange={enabled => { void props.owner.setPreference({ usageAutoRefresh: enabled }); }} />
      <UsageChoice testID="usage-refresh-interval" title={t('settings.usage.sidebar.field.refreshInterval')} value={String(usageRefreshInterval(display()))} items={props.intervalItems} disabled={disabled() || display().usageAutoRefresh !== true} onChange={value => { void props.owner.setPreference({ usageRefreshIntervalMs: Number(value) }); }} />
      <UsageChoice testID="usage-display-mode" title={t('settings.usage.sidebar.field.display')} value={display().usageDisplayMode === 'remaining' ? 'remaining' : 'usage'} items={[{ value: 'usage', title: t('settings.usage.sidebar.field.displayModeUsage') }, { value: 'remaining', title: t('settings.usage.sidebar.field.displayModeRemaining') }]} disabled={disabled()} onChange={value => { if (value === 'usage' || value === 'remaining') void props.owner.setPreference({ usageDisplayMode: value }); }} />
      <SettingsToggle testID="usage-predictions" title={t('settings.usage.sidebar.field.showPredictions')} value={display().usageShowPredValues === true} disabled={disabled()} onChange={enabled => { void props.owner.setPreference({ usageShowPredValues: enabled }); }} />
    </SettingsGroup>
    <If when={props.state.settingsFailed}><Text testID="usage-settings-error" class="text-sm text-destructive">{t('settings.usage.page.state.refreshFailedTitle')}</Text></If>
    <If when={props.state.preferenceFailed}><Text testID="usage-preference-error" class="text-sm text-destructive">{t('settings.usage.page.state.preferenceUnconfirmed')}</Text></If>
    <If when={Object.keys(props.state.errors).length > 0}><Text testID="usage-read-error" class="text-sm text-destructive">{t('settings.usage.page.state.refreshFailedTitle')}</Text></If>
    <SettingsTarget id="usage.magpie" target={props.target} onReveal={reveal}><SettingsGroup title="Magpie">
      <Button testID="usage-magpie-save" class={settingsAction} disabled={disabled() || props.magpieDraft === null || props.magpieDraft === String(settings()?.magpieUsageUrl ?? '')} onPress={props.onSaveMagpie}><Text class="text-foreground">{t('settings.usage.magpie.save')}</Text></Button>
      <Text class="text-xs text-muted-foreground">{props.state.magpieSources.reduce((sum, source) => sum + source.resultCount, 0) > 0 ? t('settings.usage.magpie.connected', { count: props.state.magpieSources.reduce((sum, source) => sum + source.resultCount, 0) }) : t('settings.usage.magpie.description')}</Text>
      <If when={!!props.state.errors.magpie || props.state.magpieSources.some(source => source.identified && source.error)}><Text class="text-xs text-muted-foreground">{t('settings.usage.magpie.unavailable')}</Text></If>
      <Button testID="usage-magpie-manual" class="min-h-8 flex-row items-center gap-2" disabled={!props.active} onPress={props.onManualMagpie}><Text class="flex-1 text-xs text-muted-foreground">{t('settings.usage.magpie.manual')}</Text><Icon name={props.manualMagpie ? 'arrow-down-s' : 'arrow-right-s'} size={16} /></Button>
      <If when={props.manualMagpie}><SettingsInput testID="usage-magpie-url" title={t('settings.usage.magpie.url')} value={props.magpieDraft ?? String(settings()?.magpieUsageUrl ?? '')} disabled={disabled()} onChange={props.onMagpieDraft} /></If>
    </SettingsGroup></SettingsTarget>
    <View testID="desktop-usage-results" class={'min-w-0 items-start gap-5 ' + (stacked() ? 'flex-col' : 'flex-row')}>
      <View testID="desktop-usage-providers" class="min-w-0 bg-card rounded-2xl" style={{ width: stacked() ? '100%' : 256, flexShrink: 0 }}>
        <List testID="desktop-usage-provider-list" viewport="parent" each={providers()} estimatedItemSize={52}>{provider => <Button testID={`usage-provider-${provider().id}`} disabled={!props.active} class={'min-h-13 px-3.5 py-3 flex-row items-center gap-2 ' + (providerID() === provider().id ? 'bg-accent' : 'hover:bg-accent')} onPress={() => select(provider().id)}>
          <View class={provider().configured ? 'size-2.5 rounded-full' : 'size-2.5 rounded-full bg-muted-foreground opacity-40'} style={{ backgroundColor: provider().configured ? provider().tone === 'critical' ? props.palette.critical : provider().tone === 'warn' ? props.palette.warning : props.palette.safe : undefined }} />
          <HeaderProviderLogo providerID={provider().id} /><Text class="flex-1 text-sm text-foreground">{provider().name}</Text><If when={!provider().configured}><Text class="text-xs text-muted-foreground">{t('settings.usage.sidebar.status.notSet')}</Text></If>
        </Button>}</List>
      </View>
      <View testID="desktop-usage-detail" class="min-w-0" style={{ width: stacked() ? '100%' : undefined, flex: stacked() ? undefined : 1 }}><View class={'w-full min-w-0 self-center gap-5 ' + (windowSize().width < 640 ? 'p-3' : 'px-6 pt-8 pb-6')} style={{ maxWidth: 768 }}>
        <If when={!providerID()}><Text class="text-sm text-muted-foreground">{t('settings.usage.page.empty.selectProvider')}</Text></If>
        <If when={!!providerID()}>
          <View class="flex-row items-center gap-3"><HeaderProviderLogo providerID={providerID()!} /><View class="flex-1 gap-1"><Text testID="desktop-usage-provider-title" class="text-base text-foreground">{t('settings.usage.page.header.providerUsage', { provider: selected()?.providerName ?? providers().find(provider => provider.id === providerID())?.name ?? providerID()! })}</Text><Text class="text-xs text-muted-foreground">{props.state.refreshing ? t('settings.usage.page.header.refreshing') : props.updated(selected()?.fetchedAt)}</Text></View></View>
          <SettingsTarget id="usage.header-menu" target={props.target} onReveal={reveal}><SettingsGroup title=""><SettingsToggle testID="usage-header-toggle" title={t('settings.usage.page.options.showInHeader')} value={header().includes(providerID()!)} disabled={disabled() || !selected()} onChange={enabled => { if (props.active) void props.owner.selectHeader(providerID()!, enabled); }} /><Text class="text-xs text-muted-foreground">{t('settings.usage.page.options.showInHeaderTooltip')}</Text></SettingsGroup></SettingsTarget>
          <If when={!selected() && !props.state.refreshing && !failed()}><Text testID="usage-no-data" class="text-sm text-muted-foreground">{t('settings.usage.page.state.noData')}</Text></If>
          <If when={!!selected() && !selected()!.configured}><View class="gap-1"><Text class="text-sm" style={{ color: props.palette.warning }}>{t('settings.usage.page.state.providerNotConfiguredTitle')}</Text><Text class="text-xs text-muted-foreground">{t('settings.usage.page.state.providerNotConfiguredDescription')}</Text></View></If>
          <If when={selected()?.configured && !selected()?.ok && !!selected()?.error}><View class="gap-1"><Text class="text-sm text-destructive">{t('settings.usage.page.state.refreshFailedTitle')}</Text><Text class="text-xs text-destructive">{selected()!.error}</Text></View></If>
          <SettingsTarget id="usage.model-quotas" target={props.target} onReveal={reveal}><List testID="desktop-usage-detail-list" viewport="parent" each={rows()} estimatedItemSize={120}>{row => <View class="min-w-0 bg-card px-4">
            <If when={row().kind === 'account'}>{() => { const account = computed(() => (row() as Extract<ReturnType<typeof rows>[number], { kind: 'account' }>).account); return <View testID={`usage-account-${account().id}`} class="gap-1 py-3"><Text class="text-sm text-foreground">{account().name}</Text><Text class="text-xs text-muted-foreground">{[account().user, account().plan, account().from].filter(Boolean).join(' · ')}</Text><If when={!!account().readAt}><Text class="text-xs text-muted-foreground">{props.updated(account().readAt)}</Text></If><If when={account().stale}><Text testID={`usage-stale-${account().id}`} class="text-xs text-muted-foreground">{t('settings.usage.magpie.cached')}</Text></If><If when={!!account().error}><Text class="text-xs text-destructive">{t('settings.usage.page.state.refreshFailedTitle')}</Text></If></View>; }}</If>
            <If when={row().kind === 'models'}><Text class="text-xs text-muted-foreground py-3">{t('settings.usage.page.section.modelQuotas')}</Text></If>
            <If when={row().kind === 'family'}>{() => { const family = computed(() => (row() as Extract<ReturnType<typeof rows>[number], { kind: 'family' }>).family); return <Button testID={`usage-family-${family().id}`} class="min-h-8 py-1 flex-row items-center gap-2" disabled={!props.active} onPress={() => { if (props.active) collapsed.set({ ...collapsed(), [family().id]: !collapsed()[family().id] }); }}><Text class="flex-1 text-sm text-foreground">{family().label ?? t('settings.usage.page.section.otherModels')}</Text><Text class="text-xs text-muted-foreground">({family().models.length})</Text><Icon name={collapsed()[family().id] ? 'arrow-right-s' : 'arrow-down-s'} size={16} /></Button>; }}</If>
            <If when={row().kind === 'window'}>{() => { const entry = computed(() => row() as Extract<ReturnType<typeof rows>[number], { kind: 'window' }>); return props.window({ get id() { return entry().id; }, get title() { return entry().title; }, get window() { return entry().window; }, get mode() { return mode(); }, get now() { return props.state.now; }, get predictions() { return settings()?.usageShowPredValues === true; }, get palette() { return props.palette; } }); }}</If>
            <If when={row().kind === 'model'}>{() => { const model = computed(() => (row() as Extract<ReturnType<typeof rows>[number], { kind: 'model' }>).model); return props.window({ get id() { return model().id; }, get title() { return model().windows[0][0]; }, get subtitle() { return model().name; }, get window() { return model().windows[0][1]; }, get mode() { return mode(); }, get now() { return props.state.now; }, get predictions() { return settings()?.usageShowPredValues === true; }, get palette() { return props.palette; }, get selected() { return models().has(model().id); }, get disabled() { return disabled(); }, onChange: enabled => { if (props.active) void props.owner.selectModel(providerID()!, model().id, enabled); } }); }}</If>
          </View>}</List></SettingsTarget>
          <If when={selected()?.configured && !!selected()?.usage && !rows().length && !failed()}><View testID="usage-no-windows" class="gap-1"><Text class="text-sm text-foreground">{t('settings.usage.page.state.noQuotaWindowsTitle')}</Text><Text class="text-xs text-muted-foreground">{t('settings.usage.page.state.noQuotaWindowsDescription')}</Text></View></If>
        </If>
      </View></View>
    </View>
  </Scroll>;
}
