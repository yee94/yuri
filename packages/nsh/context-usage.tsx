import { cleanup, computed, effect, lifecycle, List, signal, Text, untracked, View, Clipboard } from 'nsh';
import { Button, Editor, NavPage } from 'nsh/base';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { DisplayTimePreference } from '../ui/src/lib/time-format-core';
import { deriveMessageRole } from '../ui/src/components/chat/message/messageRole';
import { t } from './i18n';
import { Icon } from './Icon';
import { createContextUsageOwner, contextUsageTokens, contextUsageKnownTokens, contextUsageScopeKey, type ContextUsageOwner, type ContextUsageScope, type ContextUsageSnapshot, type ContextUsageEntry } from './context-usage-core';
import { contextUsageNumber, contextUsageMoney, contextUsageDate, derivePartsLabel, deriveUserSnippet, formatAssistantTokensWithTps, formatMessagePreviewTime } from './context-usage-format';
import type { ContextUsagePalette } from './context-usage-palette';
export type { ContextUsagePalette } from './context-usage-palette';

export type ContextUsageSource = { kind: 'snapshot'; value: ContextUsageSnapshot } | { kind: 'patch'; scope: ContextUsageScope; entries: ContextUsageEntry[] } | { kind: 'loading' } | { kind: 'error'; error: string };
export interface NativeContextUsageProps {
  scope: ContextUsageScope | null;
  /** Stable snapshot on entry/structural change; changed canonical records for streaming. */
  source?: ContextUsageSource;
  /** A production route supplies its synchronous commit owner; fixtures may use source events. */
  projection?: { owner: ContextUsageOwner; revision: number };
  active: boolean;
  current: () => boolean;
  showAssistantTps: boolean;
  timeFormat: DisplayTimePreference;
  locale: string;
  /** Current Host chart colors: actual primary.base/status.warning, not NSH's neutral action primary. */
  palette: ContextUsagePalette;
  onRetry: () => void;
}
const cell = 'rounded-lg bg-card/70 px-3 py-2.5';
const small = 'text-xs text-muted-foreground';

/** Full context overview, distinct from the header metadata/quota popup. */
export function NativeContextUsagePage(props: NativeContextUsageProps) {
  return <NavPage title={t('commandPalette.item.showContextUsage')} headerBackTitle="" hidesBottomBarWhenPushed class="flex-1 bg-background">
    <If when={!!props.scope} else={<View class="flex-1 items-center justify-center p-6"><Text class={small}>{t('contextSidebar.empty.openSession')}</Text></View>}>
      <Each of={props.scope ? [props.scope] : []} key={scope => contextUsageScopeKey(scope)}>{scope => <ContextUsageContent {...props} scope={scope()} />}</Each>
    </If>
  </NavPage>;
}

function ContextUsageContent(props: NativeContextUsageProps & { scope: ContextUsageScope }) {
  const revision = signal(0), expanded = signal<ReadonlySet<string>>(new Set()), copiedID = signal<string | null>(null), copyError = signal('');
  let copyTimer: ReturnType<typeof setTimeout> | undefined, copySerial = 0;
  const owner = props.projection?.owner ?? createContextUsageOwner(props.scope, { showAssistantTps: props.showAssistantTps, current: props.current, changed: () => revision.update(value => value + 1) });
  const version = () => props.projection?.revision ?? revision();
  cleanup(() => { if (!props.projection) owner.dispose(); copySerial++; if (copyTimer) clearTimeout(copyTimer); });
  effect(() => { if (!props.active || lifecycle() !== 'active') { copySerial++; copiedID.set(null); if (copyTimer) clearTimeout(copyTimer); } });
  function toggle(id: string) { const next = new Set(expanded()); if (next.has(id)) next.delete(id); else next.add(id); expanded.set(next); }
  async function copy(id: string, value: string) {
    if (!props.active || !props.current()) return;
    const serial = ++copySerial; copyError.set('');
    try { await Clipboard.writeText(value); if (serial !== copySerial || !props.current()) return; copiedID.set(id); if (copyTimer) clearTimeout(copyTimer); copyTimer = setTimeout(() => copiedID.set(null), 2000); }
    catch (failure) { if (serial === copySerial && props.current()) { copiedID.set(null); copyError.set(String(failure)); } }
  }
  effect(() => { const show = props.showAssistantTps; if (props.active && lifecycle() === 'active') untracked(() => owner.setShowAssistantTps(show)); });
  effect(() => {
    if (props.projection) return;
    const source = props.source ?? { kind: 'loading' as const }, visible = props.active && lifecycle() === 'active';
    if (!visible || !props.current()) return;
    untracked(() => {
      try {
        if (source.kind === 'snapshot') owner.reset(source.value);
        else if (source.kind === 'patch') owner.patch(source);
        else if (source.kind === 'loading') owner.loading();
        else owner.failed(source.error);
      } catch (failure) { owner.failed(failure); }
    });
  });
  const state = computed(() => { version(); return owner.state(); });
  const ids = computed(() => { version(); return owner.order(); });
  return <List testID="context-usage-list" class="flex-1 bg-background" contentClass="px-5 pb-6 gap-1" each={ids()} keyExtractor={id => id}
    header={<View class="pt-6">
      <If when={state().loading}><Text class={small}>{t('common.loading')}</Text></If>
      <If when={state().error}><View class="gap-2 pb-3"><Text class="text-xs text-destructive">{t('contextSidebar.error.load')}</Text><Text testID="context-usage-error" class="text-xs text-destructive">{state().error}</Text><Button testID="context-usage-retry" class="min-h-11 bg-secondary rounded-lg px-3 items-center justify-center" onPress={props.onRetry}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button></View></If>
      <If when={copyError()}><View><Text class="text-xs text-destructive">{t('memoryDebugPanel.streaming.copy.failed')}</Text><Text class="text-xs text-destructive">{copyError()}</Text></View></If>
      <If when={state().resolved}><ContextUsageSummary owner={owner} revision={version()} showAssistantTps={props.showAssistantTps} locale={props.locale} timeFormat={props.timeFormat} palette={props.palette} /></If>
    </View>}>
    {id => <ContextUsageRawRow owner={owner} id={id()} revision={version()} expanded={expanded().has(id())} copied={copiedID() === id()} onToggle={() => toggle(id())} onCopy={value => { void copy(id(), value); }} showAssistantTps={props.showAssistantTps} locale={props.locale} timeFormat={props.timeFormat} />}
  </List>;
}

function Metric(props: { label: I18nKey; value: string; boxed?: boolean }) {
  return <View class={props.boxed ? `${cell} flex-1 min-w-0` : 'min-w-0'}><Text class={small} style={{ opacity: .7 }}>{t(props.label)}</Text><Text class="text-sm text-foreground mt-0.5" style={{ fontVariant: ['tabular-nums'] }}>{props.value}</Text></View>;
}

function ContextUsageSummary(props: { owner: ContextUsageOwner; revision: number; showAssistantTps: boolean; locale: string; timeFormat: DisplayTimePreference; palette: ContextUsagePalette }) {
  const value = computed(() => { props.revision; return props.owner.view()!; });
  const known = computed(() => { props.revision; return props.owner.known(); });
  const number = (input: number) => contextUsageNumber(input, props.locale);
  const tokenCells = computed(() => [
    { label: 'contextSidebar.tokens.input' as const, value: known().tokens.input ? number(value().tokenBreakdown.input) : '—' },
    { label: 'contextSidebar.tokens.output' as const, value: known().tokens.output ? number(value().tokenBreakdown.output) : '—' },
    { label: 'contextSidebar.tokens.reasoning' as const, value: known().tokens.reasoning ? number(value().tokenBreakdown.reasoning) : '—' },
    { label: 'contextSidebar.tokens.cacheRead' as const, value: known().tokens.cacheRead ? number(value().tokenBreakdown.cacheRead) : '—' },
    { label: 'contextSidebar.tokens.cacheWrite' as const, value: known().tokens.cacheWrite ? number(value().tokenBreakdown.cacheWrite) : '—' },
    { label: 'contextSidebar.tokens.cacheHit' as const, value: known().tokens.input && known().tokens.cacheRead && known().tokens.cacheWrite && value().cacheHitRate.hasInput ? `${value().cacheHitRate.percent.toFixed(1)}%` : '—' },
    ...(props.showAssistantTps ? [{ label: 'contextSidebar.tokens.tps' as const, value: value().lastAssistantTpsLabel ?? '—' }] : []),
  ]);
  const segments = computed(() => [
    { key: 'user' as const, label: 'contextSidebar.breakdown.user' as const, color: props.palette.success },
    { key: 'assistant' as const, label: 'contextSidebar.breakdown.assistant' as const, color: props.palette.primary },
    { key: 'tool' as const, label: 'contextSidebar.breakdown.toolCalls' as const, color: props.palette.warning },
    { key: 'other' as const, label: 'contextSidebar.breakdown.other' as const, color: props.palette.muted },
  ]);
  const percentage = (key: 'user' | 'assistant' | 'tool' | 'other') => value().breakdownTotal > 0 ? value().breakdown[key] / value().breakdownTotal * 100 : 0;
  return <View>
    <View class="mb-6"><Text testID="context-usage-title" class="text-base font-semibold text-foreground" style={{ numberOfLines: 1 }}>{value().sessionTitle || t('contextSidebar.session.untitled')}</Text><Text class={small + ' mt-1'} style={{ opacity: .7 }}>{value().providerModel.providerName} / {value().providerModel.modelName}{value().createdAt ? ` · ${contextUsageDate(value().createdAt, props.timeFormat, props.locale)}` : ''}</Text></View>
    <If when={known().partial}><Text testID="context-usage-received-only" class={small + ' mb-3'}>{t('contextSidebar.raw.receivedOnly')}</Text></If>
    <View class="mb-5 rounded-lg bg-card/70 px-4 py-3.5">
      <View class="flex-row items-baseline justify-between"><Text class={small}>{t('contextSidebar.section.context')}</Text><Text testID="context-usage-total" class={small} style={{ opacity: .7 }}>{known().tokens.total ? number(value().tokenBreakdown.total) : '—'}{value().contextLimit ? ` / ${number(value().contextLimit!)}` : ''}</Text></View>
      <View class="flex-row overflow-hidden rounded-full mt-2.5" style={{ height: 4, backgroundColor: props.palette.subtle }}><If when={known().tokens.total && value().usagePercent > 0}><View class="rounded-full" style={{ width: `${Math.max(.5, value().usagePercent)}%`, height: 4, backgroundColor: value().usagePercent > 80 ? props.palette.warning : props.palette.primary }} /></If></View>
      <Text testID="context-usage-percent" class="text-xs font-medium text-foreground mt-1.5">{known().tokens.total && (value().contextLimit || value().messagesCount === 0) ? t('contextSidebar.context.percentUsed', { percent: value().usagePercent.toFixed(1) }) : '—'}</Text>
    </View>
    <View class="mb-5 gap-2"><View class="flex-row gap-2"><Metric boxed label="contextSidebar.stats.messages" value={number(value().messagesCount)} /><Metric boxed label="contextSidebar.stats.user" value={number(value().userMessagesCount)} /><Metric boxed label="contextSidebar.stats.assistant" value={number(value().assistantMessagesCount)} /></View>
      <View class="flex-row gap-2"><Metric boxed label="contextSidebar.stats.cost" value={known().cost ? contextUsageMoney(value().totalAssistantCost, props.locale) : '—'} /><If when={props.showAssistantTps}><Metric boxed label="contextSidebar.stats.sessionTps" value={value().sessionTpsLabel ?? '—'} /></If></View>
    </View>
    <View class="mb-5 rounded-lg bg-card/70 px-4 py-3.5"><Text class={small + ' mb-2.5'}>{t('contextSidebar.section.lastAssistantMessage')}</Text><View class="flex-row flex-wrap" style={{ rowGap: 10 }}><Each of={tokenCells()}>{item => <View style={{ width: '33.333%', paddingRight: 16 }}><Metric label={item().label} value={item().value} /></View>}</Each></View></View>
    <View class="mb-6"><View class="flex-row overflow-hidden rounded-full" style={{ height: 4, backgroundColor: props.palette.subtle }}><Each of={segments()}>{segment => <If when={known().composition && value().breakdown[segment().key] > 0 && value().breakdownTotal > 0}><View style={{ width: `${percentage(segment().key)}%`, height: 4, backgroundColor: segment().color }} /></If>}</Each></View>
      <View class="mt-2 flex-row flex-wrap" style={{ columnGap: 16, rowGap: 4 }}><Each of={segments()}>{segment => <View class="flex-row items-center gap-1.5"><View class="rounded-full" style={{ width: 6, height: 6, backgroundColor: segment().color }} /><Text class={small} style={{ opacity: .7 }}>{t(segment().label)} {known().composition ? `${percentage(segment().key).toFixed(0)}%` : '—'}</Text></View>}</Each></View>
    </View>
    <Text class={small + ' mb-2.5'}>{t('contextSidebar.section.rawMessages')}</Text>
  </View>;
}

function ContextUsageRawRow(props: { owner: ContextUsageOwner; id: string; revision: number; expanded: boolean; copied: boolean; onToggle: () => void; onCopy: (value: string) => void; showAssistantTps: boolean; locale: string; timeFormat: DisplayTimePreference }) {
  const entry = computed(() => { props.revision; return props.owner.message(props.id)!; });
  const role = computed(() => deriveMessageRole(entry().info));
  const label = computed(() => { const parts = derivePartsLabel(entry().parts); return role().isUser ? `user: ${deriveUserSnippet(entry().parts)}` : role().role === 'assistant' ? parts || '—' : parts ? `${role().role || 'unknown'}: ${parts}` : role().role || 'unknown'; });
  const counters = computed(() => { const tokens = contextUsageTokens(entry()), known = contextUsageKnownTokens(entry()); return role().role === 'assistant' ? formatAssistantTokensWithTps(known.input ? tokens.input : NaN, known.output ? tokens.output : NaN, count => Number.isFinite(count) ? contextUsageNumber(count, props.locale) : '—', props.showAssistantTps ? props.owner.tps(props.id) : null) : ''; });
  const json = computed(() => { entry(); return props.expanded ? props.owner.json(props.id) : ''; });
  return <View testID={`context-usage-raw-${props.id}`} class="overflow-hidden rounded-lg bg-card/70">
    <View role="button" testID={`context-usage-expand-${props.id}`} class="px-3 py-1.5 flex-row items-center gap-2 active:bg-accent" accessibilityLabel={label()} accessibilityState={{ expanded: props.expanded }} onPress={props.onToggle}>
      <View class="flex-1 min-w-0 flex-row items-baseline gap-1"><If when={role().isUser} else={<Text class={small + ' flex-1 min-w-0'} style={{ numberOfLines: 1 }}>{label()}</Text>}><Text class="text-sm text-foreground">user:</Text><Text class={small + ' flex-1 min-w-0'} style={{ numberOfLines: 1 }}>{deriveUserSnippet(entry().parts)}</Text></If></View>
      <If when={role().role === 'assistant'}><Text class={small + ' text-right'} style={{ minWidth: 120 }}>{counters()}</Text></If>
      <Text class={small + ' text-right'}>{formatMessagePreviewTime(entry().info.time?.created ?? null, props.timeFormat)}</Text>
    </View>
    <If when={props.expanded}><View class="border-t border-border bg-background">
      <View class="flex-row justify-end px-2 pt-1"><Button testID={`context-usage-copy-${props.id}`} class="p-1 rounded active:bg-accent" accessibilityLabel={t(props.copied ? 'contextSidebar.actions.copied' : 'contextSidebar.actions.copyJson')} onPress={() => props.onCopy(json())}><Icon name={props.copied ? 'check' : 'file-copy'} size={14} /></Button></View>
      <Editor testID={`context-usage-json-${props.id}`} value={json()} language="json" readOnly softWrap lineNumbers={false} folding={false} activeLine={false} indentGuides={false} completion={false} scrollBeyondLastLine={false} minRows={1} maxRows={24} fontSize={12} lineHeight={16.2} class="bg-background" style={{ maxHeight: 416 }} accessibilityLabel={t('contextSidebar.section.rawMessages')} />
    </View></If>
  </View>;
}
