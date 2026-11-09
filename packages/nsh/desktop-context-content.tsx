import { cleanup, Clipboard, computed, effect, List, signal, Text, View } from 'nsh';
import { Button, Editor, type EditorRef } from 'nsh/base';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { DisplayTimePreference } from '../ui/src/lib/time-format-core';
import { deriveMessageRole } from '../ui/src/components/chat/message/messageRole';
import { contextUsageKnownTokens, contextUsageTokens, type ContextUsageOwner } from './context-usage-core';
import { contextUsageDate, contextUsageMoney, contextUsageNumber, derivePartsLabel, deriveUserSnippet, formatAssistantTokensWithTps, formatMessagePreviewTime } from './context-usage-format';
import type { ContextUsagePalette } from './context-usage-palette';
import type { DesktopContextOwner } from './desktop-context-core';
import { Icon } from './Icon';
import { t } from './i18n';

type Presentation = { revision: number; showAssistantTps: boolean; timeFormat: DisplayTimePreference; locale: string; palette: ContextUsagePalette };
const small = 'text-xs text-muted-foreground';
const card = 'rounded-lg bg-card/70';

/** Full ContextPanelContent: summary AND raw messages, not the small header usage popup.
 * The shared incremental owner/normalizer/formatters own all arithmetic and raw-wire fidelity. */
export function DesktopContextContent(props: Presentation & { projection: DesktopContextOwner; interactive: boolean }) {
  const owner = props.projection.owner;
  const expanded = signal<ReadonlySet<string>>(new Set()), copied = signal<string | null>(null), copyFailed = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined, copyRevision = 0;
  const state = computed(() => { props.revision; return owner.state(); });
  const ids = computed(() => { props.revision; return owner.order(); });
  // Render from reactive visibility, not the route's imperative demand flags:
  // effects commit those flags after dependent views have already recomputed.
  const enabled = () => props.interactive && props.projection.current();
  const admitted = () => enabled() && props.projection.canInteract();
  const revokeCopy = () => { copyRevision++; if (timer) clearTimeout(timer); timer = undefined; copied.set(null); };
  cleanup(revokeCopy);
  effect(() => { if (!props.interactive) revokeCopy(); });
  function toggle(id: string) {
    if (!admitted()) return;
    const next = new Set(expanded()); if (next.has(id)) next.delete(id); else next.add(id); expanded.set(next);
  }
  async function copy(id: string) {
    if (!admitted()) return;
    const revision = ++copyRevision, value = owner.json(id); copyFailed.set(false);
    try {
      await Clipboard.writeText(value);
      if (revision !== copyRevision || !admitted()) return;
      copied.set(id); if (timer) clearTimeout(timer); timer = setTimeout(() => copied.set(null), 2000);
    } catch { if (revision === copyRevision && admitted()) { copied.set(null); copyFailed.set(true); } }
  }
  return <List testID="desktop-context-list" class="flex-1 bg-background" contentClass="px-5 pb-6 gap-1" each={ids()} keyExtractor={id => id} disabled={!props.interactive}
    style={{ pointerEvents: props.interactive ? 'auto' : 'none' }} scrollable={props.interactive}
    header={<View class="pt-6" style={{ maxWidth: 832, width: '100%', alignSelf: 'center' }}>
      <If when={state().loading}><Text testID="desktop-context-loading" class={small}>{t('common.loading')}</Text></If>
      <If when={!!state().error}><View testID="desktop-context-error" class="gap-2 pb-3"><Text role="alert" class="text-xs text-destructive">{t('contextSidebar.error.load')}</Text><Button testID="desktop-context-retry" class="min-h-8 rounded-lg bg-secondary px-3 items-center justify-center" disabled={!props.interactive} onPress={() => { if (enabled()) void props.projection.retry(); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button></View></If>
      <If when={copyFailed()}><Text testID="desktop-context-copy-error" role="alert" class="text-xs text-destructive">{t('memoryDebugPanel.streaming.copy.failed')}</Text></If>
      <If when={state().resolved}><DesktopContextSummary {...props} owner={owner} /></If>
    </View>}>
    {id => <DesktopContextRawRow {...props} owner={owner} id={id()} expanded={expanded().has(id())} copied={copied() === id()} enabled={enabled()} onToggle={() => toggle(id())} onCopy={() => { void copy(id()); }} />}
  </List>;
}

function Metric(props: { label: I18nKey; value: string; boxed?: boolean; testID?: string }) {
  return <View class={props.boxed ? `${card} flex-1 min-w-0 px-3 py-2.5` : 'min-w-0'}><Text class={small} style={{ opacity: .7 }}>{t(props.label)}</Text><Text testID={props.testID} class="text-sm text-foreground mt-0.5" style={{ fontVariant: ['tabular-nums'] }}>{props.value}</Text></View>;
}

function DesktopContextSummary(props: Presentation & { owner: ContextUsageOwner }) {
  const value = computed(() => { props.revision; return props.owner.view()!; });
  const known = computed(() => { props.revision; return props.owner.known(); });
  const number = (count: number) => contextUsageNumber(count, props.locale);
  const cells = computed(() => [
    { label: 'contextSidebar.tokens.input' as const, value: known().tokens.input ? number(value().tokenBreakdown.input) : '—' },
    { label: 'contextSidebar.tokens.output' as const, value: known().tokens.output ? number(value().tokenBreakdown.output) : '—' },
    { label: 'contextSidebar.tokens.reasoning' as const, value: known().tokens.reasoning ? number(value().tokenBreakdown.reasoning) : '—' },
    { label: 'contextSidebar.tokens.cacheRead' as const, value: known().tokens.cacheRead ? number(value().tokenBreakdown.cacheRead) : '—' },
    { label: 'contextSidebar.tokens.cacheWrite' as const, value: known().tokens.cacheWrite ? number(value().tokenBreakdown.cacheWrite) : '—' },
    { label: 'contextSidebar.tokens.cacheHit' as const, value: known().tokens.input && known().tokens.cacheRead && known().tokens.cacheWrite && value().cacheHitRate.hasInput ? `${value().cacheHitRate.percent.toFixed(1)}%` : '—' },
    ...(props.showAssistantTps ? [{ label: 'contextSidebar.tokens.tps' as const, value: value().lastAssistantTpsLabel ?? '—' }] : []),
  ]);
  const segments = () => [
    { key: 'user' as const, label: 'contextSidebar.breakdown.user' as const, color: props.palette.success },
    { key: 'assistant' as const, label: 'contextSidebar.breakdown.assistant' as const, color: props.palette.primary },
    { key: 'tool' as const, label: 'contextSidebar.breakdown.toolCalls' as const, color: props.palette.warning },
    { key: 'other' as const, label: 'contextSidebar.breakdown.other' as const, color: props.palette.muted },
  ];
  const percent = (key: 'user' | 'assistant' | 'tool' | 'other') => value().breakdownTotal > 0 ? value().breakdown[key] / value().breakdownTotal * 100 : 0;
  return <View testID="desktop-context-summary">
    <View class="mb-6"><Text testID="desktop-context-title" class="text-base font-semibold text-foreground" style={{ numberOfLines: 1 }}>{value().sessionTitle || t('contextSidebar.session.untitled')}</Text><Text testID="desktop-context-model" class={small + ' mt-1'} style={{ opacity: .7 }}>{value().providerModel.providerName} / {value().providerModel.modelName}{value().createdAt ? ` · ${contextUsageDate(value().createdAt, props.timeFormat, props.locale)}` : ''}</Text></View>
    <If when={known().partial}><Text testID="desktop-context-partial" class={small + ' mb-3'}>{t('contextSidebar.raw.receivedOnly')}</Text></If>
    <View class={card + ' mb-5 px-4 py-3.5'}><View class="flex-row items-baseline justify-between"><Text class={small}>{t('contextSidebar.section.context')}</Text><Text testID="desktop-context-total" class={small}>{known().tokens.total ? number(value().tokenBreakdown.total) : '—'}{value().contextLimit ? ` / ${number(value().contextLimit!)}` : ''}</Text></View>
      <View class="overflow-hidden rounded-full mt-2.5" style={{ height: 4, backgroundColor: props.palette.subtle }}><If when={known().tokens.total && value().usagePercent > 0}><View class="rounded-full" style={{ height: 4, width: `${Math.max(.5, value().usagePercent)}%`, backgroundColor: value().usagePercent > 80 ? props.palette.warning : props.palette.primary }} /></If></View>
      <Text testID="desktop-context-percent" class="text-xs font-medium text-foreground mt-1.5">{known().tokens.total && (value().contextLimit || value().messagesCount === 0) ? t('contextSidebar.context.percentUsed', { percent: value().usagePercent.toFixed(1) }) : '—'}</Text>
    </View>
    <View class="mb-5 gap-2"><View class="flex-row gap-2"><Metric boxed label="contextSidebar.stats.messages" testID="desktop-context-message-count" value={number(value().messagesCount)} /><Metric boxed label="contextSidebar.stats.user" value={number(value().userMessagesCount)} /><Metric boxed label="contextSidebar.stats.assistant" value={number(value().assistantMessagesCount)} /></View><View class="flex-row gap-2"><Metric boxed label="contextSidebar.stats.cost" testID="desktop-context-cost" value={known().cost ? contextUsageMoney(value().totalAssistantCost, props.locale) : '—'} /><If when={props.showAssistantTps}><Metric boxed label="contextSidebar.stats.sessionTps" testID="desktop-context-session-tps" value={value().sessionTpsLabel ?? '—'} /></If></View></View>
    <View class={card + ' mb-5 px-4 py-3.5'}><Text class={small + ' mb-2.5'}>{t('contextSidebar.section.lastAssistantMessage')}</Text><View class="flex-row flex-wrap" style={{ rowGap: 10 }}><Each of={cells()}>{cell => <View style={{ width: '33.333%', paddingRight: 16 }}><Metric label={cell().label} value={cell().value} /></View>}</Each></View></View>
    <View testID="desktop-context-composition" class="mb-6"><View class="flex-row overflow-hidden rounded-full" style={{ height: 4, backgroundColor: props.palette.subtle }}><Each of={segments()}>{segment => <If when={known().composition && value().breakdown[segment().key] > 0 && value().breakdownTotal > 0}><View style={{ width: `${percent(segment().key)}%`, height: 4, backgroundColor: segment().color }} /></If>}</Each></View><View class="mt-2 flex-row flex-wrap" style={{ columnGap: 16, rowGap: 4 }}><Each of={segments()}>{segment => <View class="flex-row items-center gap-1.5"><View class="rounded-full" style={{ width: 6, height: 6, backgroundColor: segment().color }} /><Text class={small} style={{ opacity: .7 }}>{t(segment().label)} {known().composition ? `${percent(segment().key).toFixed(0)}%` : '—'}</Text></View>}</Each></View></View>
    <Text class={small + ' mb-2.5'}>{t('contextSidebar.section.rawMessages')}</Text>
  </View>;
}

function DesktopContextRawRow(props: Presentation & { owner: ContextUsageOwner; id: string; expanded: boolean; copied: boolean; enabled: boolean; onToggle: () => void; onCopy: () => void }) {
  const entry = computed(() => { props.revision; return props.owner.message(props.id)!; });
  const role = computed(() => deriveMessageRole(entry().info));
  const label = computed(() => { const parts = derivePartsLabel(entry().parts); return role().isUser ? `user: ${deriveUserSnippet(entry().parts)}` : role().role === 'assistant' ? parts || '—' : parts ? `${role().role || 'unknown'}: ${parts}` : role().role || 'unknown'; });
  const counters = computed(() => { const tokens = contextUsageTokens(entry()), known = contextUsageKnownTokens(entry()); return formatAssistantTokensWithTps(known.input ? tokens.input : NaN, known.output ? tokens.output : NaN, count => Number.isFinite(count) ? contextUsageNumber(count, props.locale) : '—', props.showAssistantTps ? props.owner.tps(props.id) : null); });
  const json = computed(() => { entry(); return props.expanded ? props.owner.json(props.id) : ''; });
  let editor: EditorRef | undefined;
  effect(() => { if (!props.enabled) editor?.blur(); });
  return <View testID={`desktop-context-raw-${props.id}`} class={card + ' overflow-hidden'} disabled={!props.enabled} style={{ width: '100%', maxWidth: 832, alignSelf: 'center' }}>
    <View role="button" disabled={!props.enabled} focusable={props.enabled} testID={`desktop-context-expand-${props.id}`} class="px-3 py-1.5 flex-row items-center gap-2 hover:bg-accent" accessibilityLabel={label()} accessibilityState={{ expanded: props.expanded, disabled: !props.enabled }} onPress={props.onToggle}>
      <Text class={small + ' flex-1 min-w-0'} style={{ numberOfLines: 1 }}>{label()}</Text>
      <If when={role().role === 'assistant'}><Text class={small + ' text-right'} style={{ minWidth: 120, fontVariant: ['tabular-nums'] }}>{counters()}</Text></If>
      <Text class={small + ' text-right'}>{formatMessagePreviewTime(entry().info.time?.created ?? null, props.timeFormat)}</Text>
    </View>
    <If when={props.expanded}><View class="border-t border-border bg-background">
      <View class="flex-row justify-end px-2 pt-1"><Button testID={`desktop-context-copy-${props.id}`} class="p-1 rounded hover:bg-accent" disabled={!props.enabled} accessibilityLabel={t(props.copied ? 'contextSidebar.actions.copied' : 'contextSidebar.actions.copyJson')} onPress={props.onCopy}><Icon name={props.copied ? 'check' : 'file-copy'} size={14} /></Button></View>
      <Editor ref={ref => { editor = ref; if (!props.enabled) ref.blur(); }} testID={`desktop-context-json-${props.id}`} value={json()} language="json" readOnly softWrap lineNumbers={false} folding={false} activeLine={false} indentGuides={false} completion={false} scrollBeyondLastLine={false} minRows={1} maxRows={24} fontSize={12} lineHeight={16.2} class="bg-background" style={{ maxHeight: 416 }} accessibilityLabel={t('contextSidebar.section.rawMessages')} />
    </View></If>
  </View>;
}
