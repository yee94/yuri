import { cleanup, colorScheme, computed, effect, lifecycle, locale, Scroll, signal, Text, untracked, View, type ScrollRef } from 'nsh';
import { Button, Progress, Switch } from 'nsh/base';
import { language, t } from './i18n';
import { nativeAppearance, nativeTimeFormat, nativeDensity } from './appearance';
import { Icon } from './Icon';
import { HeaderProviderLogo } from './chat-header-provider-logo';
import { formatTimeForLocale } from '../ui/src/lib/time-format-core';
import type { QuotaProviderId, UsageWindow } from '../ui/src/types/quota';
import { quotaProviders } from '../ui/src/lib/quota/providers';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsChoice, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime } from './settings-controls';
import { SettingsTarget } from './settings-target';
import { createSettingsTargetNavigation } from './settings-search-core';
import { createSettingsUsage, usageAccountRows, usageHeaderProviders, usageModelGroups, usageModelSelection, usageRefreshInterval, usageValueLabel, type UsageState } from './settings-usage-core';
import { createUsageQuotaHelpers } from './settings-usage-quota';
import { usageSemanticPalette, type UsagePalette } from './settings-usage-palette';

// Like Web's non-persisted quota store, only the selected identity survives page remounts.
let rememberedProvider: QuotaProviderId | null = null;

const intlLocale = () => language() === 'system' ? locale() : language();
const helpers = createUsageQuotaHelpers({
  t,
  formatTimeForPreference: (timestamp, preference, options) => formatTimeForLocale(timestamp, preference, intlLocale(), options),
  formatDateTimeForPreference: (timestamp, preference, options) => new Date(timestamp).toLocaleString(intlLocale(), { ...options, hour12: options.hour ? preference === '12h' ? true : preference === '24h' ? false : undefined : options.hour12 }),
});

function UsageWindowRow(props: { id: string; title: string; window: UsageWindow; mode: 'usage' | 'remaining'; now: number; subtitle?: string; selected?: boolean; disabled?: boolean; predictions: boolean; palette: UsagePalette; onChange?: (enabled: boolean) => void }) {
  const percent = computed(() => helpers.clampPercent(props.mode === 'remaining' ? props.window.remainingPercent : props.window.usedPercent));
  const reset = computed(() => { props.now; return helpers.formatQuotaResetLabel(props.window.resetAt, props.window.resetAfterFormatted ?? props.window.resetAtFormatted, nativeTimeFormat() ?? 'auto'); });
  const pace = computed(() => { props.now; return props.window.disablePace ? null : helpers.calculatePace(props.window.usedPercent ?? null, props.window.resetAt ?? null, props.window.windowSeconds ?? null, props.title); });
  const expected = computed(() => { const value = pace(); if (!value || value.dailyAllocationPercent === null) return null; const used = helpers.calculateExpectedUsagePercent(value.elapsedRatio); return props.mode === 'remaining' ? 100 - used : used; });
  const tone = computed(() => helpers.resolveUsageTone(props.window.usedPercent ?? (props.mode === 'remaining' ? props.window.remainingPercent : null)));
  const paceColor = computed(() => pace()?.status === 'on-track' ? props.palette.safe : pace()?.status === 'slightly-fast' ? props.palette.warning : props.palette.critical);
  const paceLabel = computed(() => t(pace()?.status === 'on-track' ? 'settings.usage.pace.status.onTrack' : pace()?.status === 'slightly-fast' ? 'settings.usage.pace.status.slightlyFast' : pace()?.status === 'too-fast' ? 'settings.usage.pace.status.tooFast' : 'settings.usage.pace.status.usedUp'));
  const countdown = computed(() => {
    if (!props.window.disablePace || !props.window.resetAt || !Number.isFinite(props.window.resetAt)) return '';
    const minutes = Math.max(0, Math.ceil((props.window.resetAt - props.now) / 60000));
    return [{ unit: 'day', value: Math.floor(minutes / 1440) }, { unit: 'hour', value: Math.floor((minutes % 1440) / 60) }, { unit: 'minute', value: minutes % 60 }]
      .filter(({ unit, value }) => value > 0 || unit === 'minute' && minutes === 0)
      .map(({ unit, value }) => new Intl.NumberFormat(intlLocale(), { style: 'unit', unit, unitDisplay: 'long' }).format(value)).join(' ');
  });
  return <View testID={`usage-window-${props.id}`} class="gap-2 py-3 border-b border-border">
    <View class="flex-row items-center gap-3"><View class="flex-1 gap-1"><Text class="text-sm text-foreground">{helpers.formatWindowLabel(props.title)}</Text><If when={!!props.subtitle}><Text class="text-xs text-muted-foreground">{props.subtitle}</Text></If></View><Text testID={`usage-value-${props.id}`} class="text-sm text-foreground">{usageValueLabel(props.window, props.mode)}</Text><If when={!!props.onChange}><Switch testID={`usage-model-${props.id}`} checked={props.selected === true} disabled={props.disabled} onChange={event => props.onChange?.(event.checked)} accessibilityLabel={t('settings.usage.page.options.showInHeaderAria')} trackClass="w-11 rounded-full bg-secondary p-0.5 checked:bg-foreground disabled:opacity-40" thumbClass="size-5 rounded-full bg-background checked:translate-x-5" /></If></View>
    <If when={percent() !== null}><View class="relative"><Progress testID={`usage-progress-${props.id}`} value={percent()!} accessibilityLabel={helpers.formatWindowLabel(props.title)} trackClass="h-1.5 rounded-full bg-border" indicatorClass="h-full" indicatorStyle={{ backgroundColor: tone() === 'critical' ? props.palette.critical : tone() === 'warn' ? props.palette.warning : props.palette.safe }} /><If when={expected() !== null && expected()! > 0 && expected()! < 100}><View class="absolute top-0 h-1.5 w-0.5 bg-foreground" style={{ left: `${expected()!}%` }} /></If></View><Text class="text-xs text-muted-foreground">{t(props.mode === 'remaining' ? 'vscodeLayout.quota.mode.remaining' : 'vscodeLayout.quota.mode.used')}</Text></If>
    <If when={!!reset()}><Text testID={`usage-reset-${props.id}`} class="text-xs text-muted-foreground">{t('settings.usage.page.window.resets', { time: reset() })}{countdown() ? ` (${countdown()})` : ''}</Text></If>
    <If when={props.predictions && !!pace()}><View class="flex-row items-center gap-2"><Text class="flex-1 text-xs text-muted-foreground">{pace()!.isExhausted ? '' : t('settings.usage.pace.rate', { rate: pace()!.paceRateText })}</Text><Text class="text-xs" style={{ color: paceColor() }}>{pace()!.isExhausted ? `${t('settings.usage.pace.status.usedUp')}${t('settings.usage.pace.waitSeparator')}${helpers.formatRemainingTime(pace()!.remainingSeconds)}` : t('settings.usage.pace.prediction', { prediction: pace()!.predictText })}</Text><View class="size-2 rounded-full" style={{ backgroundColor: paceColor() }} accessibilityLabel={paceLabel()} /></View></If>
  </View>;
}

/** Native Settings controls; projection, request budget and mutation recovery share one page owner. */
export function SettingsUsage(props: SettingsCallbacks & SettingsRoute & { directory?: string; active?: boolean; dependencies?: Omit<Parameters<typeof createSettingsUsage>[0], 'changed'> }) {
  const lifetime = settingsPageLifetime(() => props.active !== false && lifecycle() === 'active');
  const initialOperation = lifetime.operation();
  const owner = createSettingsUsage({ selectedProviderId: props.entity ?? rememberedProvider, defaultsEnabled: !!props.entity, displayClock: !!props.entity, ...(props.dependencies ?? { send: initialOperation?.request ?? (async () => { throw new Error('Runtime changed'); }), current: initialOperation?.current ?? (() => false), directory: props.directory }), onSelectedProvider: provider => { rememberedProvider = provider; }, changed: next => state.set(next) });
  const state = signal<UsageState>(owner.state()), collapsed = signal<Record<string, boolean>>({});
  lifetime.observeOperation(operation => { if (!props.dependencies) owner.replaceLane(operation); });
  const manualMagpie = signal(false), magpieDraft = signal<string | null>(null);
  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, lifetime.current, () => lifetime.operation()?.current ?? (() => false));
  const selected = computed(() => state().results.find(result => result.providerId === (state().selectedProviderId ?? props.entity)));
  const palette = computed(() => usageSemanticPalette(nativeAppearance.current(), colorScheme()));
  const displaySettings = computed(() => ({ ...(state().settings ?? {}), ...(state().draft ?? {}) }));
  const selectedModels = computed(() => new Set(selected() ? usageModelSelection(displaySettings(), selected()!) : []));
  const headerProviders = computed(() => usageHeaderProviders(displaySettings(), state().results));
  const mode = () => state().settings?.usageDisplayMode === 'remaining' ? 'remaining' as const : 'usage' as const;
  const disabled = () => !state().settings || state().writing || state().refreshing || state().recovery || props.active === false || lifecycle() !== 'active';
  const updated = (timestamp: number | null | undefined) => t('settings.usage.page.header.lastUpdated', { time: timestamp && Number.isFinite(timestamp) ? formatTimeForLocale(timestamp, nativeTimeFormat() ?? 'auto', intlLocale()) : '-' });
  const groups = computed(() => selected() ? usageModelGroups(selected()!) : []);
  const accounts = computed(() => selected() ? usageAccountRows(selected()!) : []);
  const hasWindows = computed(() => accounts().some(row => row.windows.length) || groups().length > 0);
  const providerSummaries = computed(() => quotaProviders(state().results).map(provider => {
    const result = state().results.find(result => result.providerId === provider.id);
    const values = Object.values(result?.usage?.windows ?? {}).map(window => window.usedPercent).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return { ...provider, configured: result?.configured === true, tone: helpers.resolveUsageTone(values.length ? Math.max(...values) : null) };
  }));
  async function saveMagpie() {
    const operation = lifetime.operation();
    if (!props.dependencies && !operation?.current()) return;
    const captured = magpieDraft(), value = (captured ?? String(state().settings?.magpieUsageUrl ?? '')).trim();
    await owner.setPreference({ magpieUsageUrl: value });
    if ((props.dependencies ? props.dependencies.current() : operation?.current()) && magpieDraft() === captured && state().settings?.magpieUsageUrl === value && !state().draft) magpieDraft.set(null);
  }
  effect(() => {
    const visible = props.active !== false && lifecycle() === 'active' && (props.dependencies ? props.dependencies.current() : lifetime.current());
    untracked(() => owner.setActive(visible));
    if (!visible) return;
  });
  cleanup(() => owner.dispose());
  return <Scroll testID="usage-scroll" ref={scroll} onScroll={navigation.onScroll} class="flex-1" contentClass="p-5 gap-5 pb-10" contentStyle={nativeDensity().pages.settings}>
    <Button testID="usage-refresh" class={settingsAction} disabled={state().refreshing || state().writing || props.active === false || lifecycle() !== 'active'} onPress={() => { void owner.refresh(); }}><Text class="text-foreground">{t('settings.usage.sidebar.actions.refreshTitle')}</Text></Button>
    <If when={state().settingsFailed}><Text testID="usage-settings-error" class="text-sm text-destructive">{t('settings.usage.page.state.refreshFailedTitle')}</Text></If>
    <If when={state().preferenceFailed}><Text testID="usage-preference-error" class="text-sm text-destructive">{t('settings.usage.page.state.preferenceUnconfirmed')}</Text></If>
    <Each of={Object.keys(state().errors)} key={id => id}>{id => <Text class="text-xs text-destructive">{id()} · {t('settings.usage.page.state.refreshFailedTitle')}</Text>}</Each>
    <If when={!props.entity}><SettingsGroup title="">
      <SettingsToggle testID="usage-auto-refresh" title={t('settings.usage.sidebar.field.autoRefresh')} value={displaySettings().usageAutoRefresh === true} disabled={disabled()} onChange={enabled => { void owner.setPreference({ usageAutoRefresh: enabled }); }} />
      <SettingsChoice testID="usage-refresh-interval" title={t('settings.usage.sidebar.field.refreshInterval')} value={String(usageRefreshInterval(displaySettings()))} disabled={disabled() || displaySettings().usageAutoRefresh !== true} items={[{ value: '30000', title: new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: 'second', unitDisplay: 'short' }).format(30) }, { value: '60000', title: new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(1) }, { value: '300000', title: new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(5) }]} onChange={value => { void owner.setPreference({ usageRefreshIntervalMs: Number(value) }); }} />
      <SettingsChoice testID="usage-display-mode" title={t('settings.usage.sidebar.field.display')} value={displaySettings().usageDisplayMode === 'remaining' ? 'remaining' : 'usage'} disabled={disabled()} items={[{ value: 'usage', title: t('settings.usage.sidebar.field.displayModeUsage') }, { value: 'remaining', title: t('settings.usage.sidebar.field.displayModeRemaining') }]} onChange={value => { if (value === 'usage' || value === 'remaining') void owner.setPreference({ usageDisplayMode: value }); }} />
      <SettingsToggle testID="usage-predictions" title={t('settings.usage.sidebar.field.showPredictions')} value={displaySettings().usageShowPredValues === true} disabled={disabled()} onChange={enabled => { void owner.setPreference({ usageShowPredValues: enabled }); }} />
    </SettingsGroup>
    <SettingsTarget id="usage.magpie" target={props.target} onReveal={navigation.reveal}><SettingsGroup title="Magpie">
      <Button testID="usage-magpie-save" class={settingsAction} disabled={disabled() || magpieDraft() === null || magpieDraft() === String(state().settings?.magpieUsageUrl ?? '')} onPress={() => { void saveMagpie(); }}><Text class="text-foreground">{t('settings.usage.magpie.save')}</Text></Button>
      <Text class="text-xs text-muted-foreground">{state().magpieSources.reduce((sum, source) => sum + source.resultCount, 0) > 0 ? t('settings.usage.magpie.connected', { count: state().magpieSources.reduce((sum, source) => sum + source.resultCount, 0) }) : t('settings.usage.magpie.description')}</Text>
      <If when={!!state().errors.magpie || state().magpieSources.some(source => source.identified && source.error)}><Text class="text-xs text-muted-foreground">{t('settings.usage.magpie.unavailable')}</Text></If>
      <Button testID="usage-magpie-manual" class="min-h-11 flex-row items-center gap-2" onPress={() => manualMagpie.set(!manualMagpie())}><Text class="flex-1 text-xs text-muted-foreground">{t('settings.usage.magpie.manual')}</Text><Icon name={manualMagpie() ? 'arrow-down-s' : 'arrow-right-s'} size={16} /></Button>
      <If when={manualMagpie()}><SettingsInput testID="usage-magpie-url" title={t('settings.usage.magpie.url')} value={magpieDraft() ?? String(state().settings?.magpieUsageUrl ?? '')} disabled={disabled()} onChange={value => magpieDraft.set(value)} /></If>
    </SettingsGroup></SettingsTarget>
    <SettingsGroup title={t('settings.usage.sidebar.title')}><Each of={providerSummaries()} key={provider => provider.id}>{provider => <Button testID={`usage-provider-${provider().id}`} class={state().selectedProviderId === provider().id ? 'min-h-12 py-3 flex-row items-center gap-2 rounded-xl bg-accent' : 'min-h-12 py-3 flex-row items-center gap-2'} onPress={() => { owner.selectProvider(provider().id); props.onOpen({ page: 'usage', entity: provider().id }); }}><View class={provider().configured ? 'size-2.5 rounded-full' : 'size-2.5 rounded-full bg-muted-foreground opacity-40'} style={{ backgroundColor: provider().configured ? provider().tone === 'critical' ? palette().critical : provider().tone === 'warn' ? palette().warning : palette().safe : undefined }} /><HeaderProviderLogo providerID={provider().id} /><Text class="flex-1 text-foreground">{provider().name}</Text><If when={!provider().configured}><Text class="text-xs text-muted-foreground">{t('settings.usage.sidebar.status.notSet')}</Text></If></Button>}</Each></SettingsGroup></If>
    <If when={!!props.entity && !selected() && !state().refreshing}><Text class="text-muted-foreground">{t('settings.usage.page.state.noData')}</Text></If>
    <If when={!!props.entity && !!selected()}>
      <View class="flex-row items-center gap-3"><HeaderProviderLogo providerID={selected()!.providerId} /><View class="flex-1 gap-1"><Text class="text-base text-foreground">{t('settings.usage.page.header.providerUsage', { provider: selected()!.providerName })}</Text><Text class="text-xs text-muted-foreground">{state().refreshing ? t('settings.usage.page.header.refreshing') : updated(selected()!.fetchedAt)}</Text></View></View>
      <SettingsGroup title=""><SettingsTarget id="usage.header-menu" target={props.target} onReveal={navigation.reveal}><SettingsToggle testID="usage-header-toggle" title={t('settings.usage.page.options.showInHeader')} value={headerProviders().includes(selected()!.providerId)} disabled={disabled()} onChange={enabled => { void owner.selectHeader(selected()!.providerId, enabled); }} /><Text class="text-xs text-muted-foreground">{t('settings.usage.page.options.showInHeaderTooltip')}</Text></SettingsTarget></SettingsGroup>
      <If when={!selected()!.configured}><View class="gap-1"><Text class="text-sm text-foreground">{t('settings.usage.page.state.providerNotConfiguredTitle')}</Text><Text class="text-xs text-muted-foreground">{t('settings.usage.page.state.providerNotConfiguredDescription')}</Text></View></If>
      <If when={selected()!.configured && !selected()!.ok && !!selected()!.error}><View class="gap-1"><Text class="text-sm text-destructive">{t('settings.usage.page.state.refreshFailedTitle')}</Text><Text class="text-xs text-destructive">{selected()!.error}</Text></View></If>
      <Each of={accounts()} key={account => account.id}>{account => <View testID={`usage-account-${account().id}`}><SettingsGroup title={account().name}>
        <If when={account().account}><Text class="text-xs text-muted-foreground">{[account().user, account().plan, account().from].filter(Boolean).join(' · ')}</Text><If when={!!account().readAt}><Text class="text-xs text-muted-foreground">{updated(account().readAt)}</Text></If><If when={account().stale}><Text testID={`usage-stale-${account().id}`} class="text-xs text-muted-foreground">{t('settings.usage.magpie.cached')}</Text></If><If when={!!account().error}><Text class="text-xs text-destructive">{t('settings.usage.page.state.refreshFailedTitle')}</Text></If></If>
        <Each of={account().windows} key={entry => entry[0]}>{entry => <UsageWindowRow id={`${account().id}:${entry()[0]}`} title={account().account ? entry()[1].label ?? entry()[0] : entry()[0]} window={entry()[1]} mode={mode()} now={state().now} predictions={state().settings?.usageShowPredValues === true} palette={palette()} />}</Each>
      </SettingsGroup></View>}</Each>
      <If when={groups().length > 0}><SettingsGroup title={t('settings.usage.page.section.modelQuotas')}><SettingsTarget id="usage.model-quotas" target={props.target} onReveal={navigation.reveal}><Each of={groups()} key={group => group.id}>{group => <View class="gap-1">
        <Button testID={`usage-family-${group().id}`} class="min-h-11 flex-row items-center gap-2" onPress={() => collapsed.set({ ...collapsed(), [group().id]: !collapsed()[group().id] })}><Text class="flex-1 text-sm text-foreground">{group().label ?? t('settings.usage.page.section.otherModels')}</Text><Text class="text-xs text-muted-foreground">({group().models.length})</Text><Icon name={collapsed()[group().id] ? 'arrow-right-s' : 'arrow-down-s'} size={16} /></Button>
        <If when={!collapsed()[group().id]}><Each of={group().models} key={model => model.id}>{model => <UsageWindowRow id={model().id} title={model().windows[0][0]} subtitle={model().name} window={model().windows[0][1]} mode={mode()} now={state().now} predictions={state().settings?.usageShowPredValues === true} palette={palette()} selected={selectedModels().has(model().id)} disabled={disabled()} onChange={enabled => { void owner.selectModel(selected()!.providerId, model().id, enabled); }} />}</Each></If>
      </View>}</Each></SettingsTarget></SettingsGroup></If>
      <If when={selected()!.configured && !!selected()!.usage && !hasWindows()}><View class="gap-1"><Text class="text-sm text-foreground">{t('settings.usage.page.state.noQuotaWindowsTitle')}</Text><Text class="text-xs text-muted-foreground">{t('settings.usage.page.state.noQuotaWindowsDescription')}</Text></View></If>
    </If>
  </Scroll>;
}
