import { colorScheme, locale, Text, token, View } from 'nsh';
import { HeaderProviderLogo } from './chat-header-provider-logo';
import { Icon } from './Icon';
import { language, t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { Button } from 'nsh/base';
import { headerQuotaReset, headerQuotaValue, type HeaderQuotaSnapshot } from './chat-header-quota';
import yuriDark from '../ui/src/lib/theme/themes/yuri-2-dark.json';
import yuriLight from '../ui/src/lib/theme/themes/yuri-2-light.json';

const labels: Record<string, I18nKey> = {
  '5h': 'quota.window.5h', '7d': 'quota.window.7d', '7d-sonnet': 'quota.window.7dSonnet', '7d-opus': 'quota.window.7dOpus', weekly: 'quota.window.weekly', daily: 'quota.window.daily', monthly: 'quota.window.monthly', credits: 'quota.window.credits', credits_balance: 'quota.window.creditsBalance', billing_cycle: 'quota.window.billingCycle', auto: 'quota.window.auto', api: 'quota.window.api', plan_limit: 'quota.window.planLimit', on_demand: 'quota.window.onDemand', session: 'quota.window.session', premium: 'quota.window.premium', chat: 'quota.window.chat', completions: 'quota.window.completions', premium_interactions: 'quota.window.premiumInteractions',
};

export function HeaderQuotaPanel(props: { snapshot?: HeaderQuotaSnapshot; onRefresh: () => void }) {
  const label = (value: string) => labels[value] ? t(labels[value]) : value;
  const resetLabel = (window: Parameters<typeof headerQuotaReset>[0]) => headerQuotaReset(window, props.snapshot?.timeFormat || 'auto', Date.now(), language() === 'system' ? locale() : language());
  const valueColor = (value: number | null) => value !== null && value >= 80 ? String(token('destructive')) : value !== null && value >= 50 ? (colorScheme() === 'dark' ? yuriDark : yuriLight).colors.status.warning : String(token('foreground'));
  return <View testID="chat-quota-panel" class="pt-2 gap-2">
    <View class="flex-row items-center gap-3 px-3 pb-1"><Icon name="timer" size={18} /><Text class="text-sm text-muted-foreground flex-1">{t('mobile.header.metadata.usage')}</Text><Button testID="chat-metadata-refresh" class="items-center justify-center disabled:opacity-40" style={{ width: 14, height: 22 }} hitSlop={10} disabled={props.snapshot?.loading} accessibilityLabel={t('chat.workStatus.usage.refresh')} onPress={props.onRefresh}><Icon name="refresh" size={14} /></Button><Text class="text-sm text-muted-foreground">{t(props.snapshot?.displayMode === 'remaining' ? 'header.services.remaining' : 'header.services.used')}</Text></View>
    <Each of={props.snapshot?.groups || []}>{group => <View class="rounded-xl bg-muted p-3 gap-2">
      <View class="flex-row items-center gap-2"><HeaderProviderLogo providerID={group().id} /><Text class="text-sm font-semibold text-foreground flex-1" style={{ numberOfLines: 1 }}>{group().name}</Text></View>
      <If when={!group().rows.length && !group().error}><Text class="text-xs text-muted-foreground">{t('header.services.noRateLimitsReported')}</Text></If>
      <Each of={group().rows}>{row => <>
        <If when={row().accountHeading}><Text class="text-xs font-semibold text-muted-foreground pt-2" style={{ numberOfLines: 1 }}>{row().accountHeading!.toLocaleUpperCase()}</Text></If>
        <View class="flex-row items-baseline gap-2">
          <View class="flex-row items-baseline flex-1 gap-1"><Text class="text-sm text-muted-foreground" style={{ flexShrink: 1, numberOfLines: 1 }}>{row().subtitle ? `${row().subtitle} · ${label(row().label)}` : label(row().label)}</Text><If when={resetLabel(row().window)}><Text class="text-xs text-muted-foreground" style={{ flexShrink: 1, numberOfLines: 1 }}>{resetLabel(row().window)}</Text></If></View>
          <Text class="text-sm font-semibold" style={{ maxWidth: '60%', numberOfLines: 1, color: valueColor(row().window.usedPercent) }}>{headerQuotaValue(row(), props.snapshot?.displayMode || 'usage')}</Text>
        </View>
        <If when={row().accountError}><Text class="text-xs text-destructive">{row().accountError}</Text></If>
        <If when={row().stale && !group().stale}><Text class="text-xs text-muted-foreground">{t('chat.questionDelegate.stale')}</Text></If>
      </>}</Each>
      <If when={group().error}><Text class="text-xs text-destructive">{group().error}</Text></If>
      <If when={group().stale}><Text class="text-xs text-muted-foreground">{t('chat.questionDelegate.stale')}</Text></If>
    </View>}</Each>
    <Each of={props.snapshot?.errors || []}>{error => <Text class="px-3 text-xs text-destructive">{error()}</Text>}</Each>
    <If when={props.snapshot?.loaded && !props.snapshot.loading && !props.snapshot.groups.length && !props.snapshot.errors.length}><Text class="px-3 text-sm text-muted-foreground">{t('header.services.noRateLimitsReported')}</Text></If>
  </View>;
}
