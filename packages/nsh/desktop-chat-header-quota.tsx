import { colorScheme, computed, locale, signal, Text, token, View } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { HeaderProviderLogo } from './chat-header-provider-logo';
import type { HeaderQuotaGroup, HeaderQuotaRow, HeaderQuotaSnapshot } from './chat-header-quota';
import { createDesktopHeaderQuotaPresentation } from './desktop-header-quota-presentation';
import { language, t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import yuriDark from '../ui/src/lib/theme/themes/yuri-2-dark.json';
import yuriLight from '../ui/src/lib/theme/themes/yuri-2-light.json';

export type DesktopChatHeaderQuotaProps = {
  snapshot?: HeaderQuotaSnapshot; refreshAvailable: boolean; modeAvailable: boolean;
  refresh: () => void; mode: (value: 'usage' | 'remaining') => void;
  /** New local expansion actions require explicit permission; identity is captured by the outer keyed consumer. */
  interactive?: boolean; current?: () => boolean;
  familyState?: DesktopHeaderQuotaFamilies;
};
/** One per outer keyed Header, outside its conditional popup/tab content. Presentation state only. */
export function createDesktopHeaderQuotaFamilies() {
  const expanded = signal<ReadonlySet<string>>(new Set());
  const key = (provider: string, family: string | null) => JSON.stringify([provider, family ?? 'other']);
  return {
    expanded: (provider: string, family: string | null) => expanded().has(key(provider, family)),
    toggle(provider: string, family: string | null) {
      const captured = key(provider, family), next = new Set(expanded());
      if (next.has(captured)) next.delete(captured); else next.add(captured);
      expanded.set(next);
    },
  };
}
export type DesktopHeaderQuotaFamilies = ReturnType<typeof createDesktopHeaderQuotaFamilies>;
const paceLabels: Record<'on-track' | 'slightly-fast' | 'too-fast' | 'exhausted', I18nKey> = {
  'on-track': 'settings.usage.pace.status.onTrack', 'slightly-fast': 'settings.usage.pace.status.slightlyFast', 'too-fast': 'settings.usage.pace.status.tooFast', exhausted: 'settings.usage.pace.status.usedUp',
};
const presentation = () => createDesktopHeaderQuotaPresentation(t, () => language() === 'system' ? locale() : language());
const warning = () => (colorScheme() === 'dark' ? yuriDark : yuriLight).colors.status.warning;
const toneColor = (tone: 'safe' | 'warn' | 'critical') => tone === 'critical' ? String(token('destructive')) : tone === 'warn' ? warning() : String(token('success'));

function QuotaRow(props: { row: HeaderQuotaRow; group: HeaderQuotaGroup; snapshot?: HeaderQuotaSnapshot; modelKey?: string; helpers: ReturnType<typeof presentation> }) {
  const metric = computed(() => props.helpers.row(props.row, props.group, props.snapshot, props.modelKey !== undefined));
  const paceColor = () => metric().pace?.status === 'exhausted' || metric().pace?.status === 'too-fast' ? String(token('destructive')) : metric().pace?.status === 'slightly-fast' ? warning() : String(token('success'));
  const id = () => props.row.key;
  return <View class="gap-1.5">
    <If when={props.row.accountHeading && props.modelKey === undefined}><Text class="text-xs text-muted-foreground pt-2" style={{ fontWeight: '500' }}>{props.row.accountHeading}</Text></If>
    <View class="flex-row items-center gap-3"><View class="flex-1 min-w-0 gap-0.5">
      <Text class={props.modelKey === undefined ? 'text-foreground' : 'text-xs text-muted-foreground'} style={{ fontSize: props.modelKey === undefined ? 13 : 12 }}>{props.modelKey === undefined ? (props.row.subtitle ? `${props.row.subtitle} · ${metric().label}` : metric().label) : props.row.subtitle ?? props.modelKey}</Text>
      <If when={metric().reset}><Text class="text-xs text-muted-foreground">{metric().reset}</Text></If>
    </View><Text testID={`desktop-chat-header-quota-value-${id()}`} class="text-foreground" style={{ fontSize: 13 }}>{metric().value}</Text></View>
    <View testID={`desktop-chat-header-quota-track-${id()}`} class="rounded-full bg-border overflow-hidden" style={{ height: 6, position: 'relative' }} accessibilityLabel={metric().value}>
      <If when={metric().percent !== null}><View testID={`desktop-chat-header-quota-fill-${id()}`} style={{ height: 6, width: `${metric().percent ?? 0}%`, backgroundColor: toneColor(metric().tone) }} /></If>
      <If when={metric().expected !== null && metric().expected! > 0 && metric().expected! < 100}><View testID={`desktop-chat-header-quota-marker-${id()}`} class="bg-foreground" style={{ position: 'absolute', left: `${metric().expected ?? 0}%`, top: 0, bottom: 0, width: 2, opacity: .6 }} /></If>
    </View>
    <If when={metric().showPace}><View testID={`desktop-chat-header-quota-pace-${id()}`} class="flex-row items-center gap-1.5">
      <View class="rounded-full" style={{ width: 8, height: 8, backgroundColor: paceColor() }} accessibilityLabel={t(paceLabels[metric().pace!.status])} />
      <Text class="text-xs" style={{ color: paceColor() }}>{metric().pace!.isExhausted ? t('settings.usage.pace.wait', { duration: props.helpers.formatRemainingTime(metric().pace!.remainingSeconds) }) : t('settings.usage.pace.prediction', { prediction: metric().pace!.predictText })}</Text>
    </View></If>
    <If when={props.row.accountError}><Text class="text-xs text-destructive">{props.row.accountError}</Text></If>
    <If when={metric().stale && !props.group.stale}><Text class="text-xs text-muted-foreground">{t('chat.questionDelegate.stale')}</Text></If>
  </View>;
}

/** Desktop presentation of the existing bounded quota snapshot. No loader or settings owner. */
export function DesktopChatHeaderQuota(props: DesktopChatHeaderQuotaProps) {
  const helpers = presentation(), localFamilies = props.familyState ?? createDesktopHeaderQuotaFamilies();
  const families = () => props.familyState ?? localFamilies;
  const canExpand = () => props.interactive === true && props.current?.() === true;
  const canAct = () => props.interactive !== false && (props.current?.() ?? true);
  const toggle = (provider: string, family: string | null) => {
    if (!canExpand()) return;
    families().toggle(provider, family);
  };
  return <View testID="desktop-chat-header-usage">
    <View class="flex-row items-center gap-2 px-4 py-2 border-b border-border">
      <View class="flex-1 min-w-0 flex-row items-baseline gap-2"><Text class="text-foreground" style={{ fontSize: 13, fontWeight: '600' }}>{t('header.services.rateLimits')}</Text>
        <Text testID="desktop-chat-header-quota-updated" class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{helpers.lastUpdated(props.snapshot)}</Text></View>
      <View class="flex-row items-center rounded-md bg-muted p-0.5">
        <Each of={['usage', 'remaining'] as const}>{mode => <Button testID={`desktop-chat-header-quota-${mode()}`} selected={props.snapshot?.displayMode === mode()} disabled={!props.modeAvailable || !canAct() || props.snapshot?.loading}
          class={`rounded-md px-2 ${props.snapshot?.displayMode === mode() ? 'bg-accent' : 'hover:bg-secondary'} disabled:opacity-50`} style={{ height: 24 }} onPress={() => { if (canAct() && props.modeAvailable && !props.snapshot?.loading) props.mode(mode()); }}><Text class="text-xs text-foreground">{t(mode() === 'usage' ? 'header.services.used' : 'header.services.remaining')}</Text></Button>}</Each>
      </View>
      <Button testID="desktop-chat-header-quota-refresh" disabled={!canAct() || !props.refreshAvailable || props.snapshot?.loading} accessibilityLabel={t('header.services.refreshRateLimitsAria')}
        class="items-center justify-center rounded-md hover:bg-secondary focus:border focus:border-ring disabled:opacity-50" style={{ width: 28, height: 28 }} onPress={() => { if (canAct() && props.refreshAvailable && !props.snapshot?.loading) props.refresh(); }}><Icon name="refresh" size={16} /></Button>
    </View>
    <If when={props.snapshot?.loading}><Text class="px-4 py-2 text-sm text-muted-foreground">{t('common.loading')}</Text></If>
    <If when={!props.snapshot}><Text class="px-4 py-3 text-sm text-muted-foreground">{t('common.unavailable')}</Text></If>
    <If when={props.snapshot && !props.snapshot.loaded && !props.snapshot.loading && !props.snapshot.groups.length && !props.snapshot.errors.length}><Text class="px-4 py-3 text-sm text-muted-foreground">{t('common.unavailable')}</Text></If>
    <View class="gap-2 px-3 py-2.5">
      <Each of={props.snapshot?.groups ?? []}>{group => <View testID={`desktop-chat-header-quota-provider-${group().id}`} class="rounded-xl bg-muted p-3 gap-3">
        <View class="flex-row items-center gap-2"><HeaderProviderLogo providerID={group().logoID} /><Text class="flex-1 text-foreground" style={{ fontSize: 13, fontWeight: '500', numberOfLines: 1 }}>{group().name}</Text></View>
        <Each of={group().desktop?.entries ?? group().rows}>{row => <QuotaRow row={row()} group={group()} snapshot={props.snapshot} helpers={helpers} />}</Each>
        <Each of={group().desktop?.families ?? []}>{family => <View class="gap-0.5">
          <Button testID={`desktop-chat-header-quota-family-${group().id}-${family().id ?? 'other'}`} disabled={!canExpand()} selected={families().expanded(group().id, family().id)} class="flex-row items-center gap-2 rounded-md px-1 py-1.5 hover:bg-secondary disabled:opacity-50" onPress={() => toggle(group().id, family().id)}>
            <Text class="flex-1 text-foreground" style={{ fontSize: 13, fontWeight: '500' }}>{family().label ?? t('header.services.modelFamily.other')}</Text><Icon name={families().expanded(group().id, family().id) ? 'arrow-down-s' : 'arrow-right-s'} size={16} />
          </Button>
          <If when={families().expanded(group().id, family().id)}><View class="gap-2.5 pl-1 pt-1 pb-1"><Each of={family().models}>{model => <QuotaRow row={model().row} modelKey={model().modelKey} group={group()} snapshot={props.snapshot} helpers={helpers} />}</Each></View></If>
        </View>}</Each>
        <If when={!group().rows.length && !group().error}><Text class="text-sm text-muted-foreground">{t('header.services.noRateLimitsReported')}</Text></If>
        <If when={group().error}><Text class="text-sm text-destructive">{group().error}</Text></If>
        <If when={group().stale}><Text class="text-xs text-muted-foreground">{t('chat.questionDelegate.stale')}</Text></If>
      </View>}</Each>
      <Each of={props.snapshot?.errors ?? []}>{error => <Text class="text-sm text-destructive">{error()}</Text>}</Each>
      <If when={props.snapshot?.loaded && !props.snapshot.loading && !props.snapshot.groups.length && !props.snapshot.errors.length}><Text class="px-1 py-2 text-sm text-muted-foreground">{t('header.services.noRateLimitsReported')}</Text></If>
    </View>
  </View>;
}
