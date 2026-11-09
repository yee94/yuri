import { cleanup, computed, effect, keymap, locale, signal, Text, untracked, View, List, type ListRef } from 'nsh';
import { Button, Dialog, Input } from 'nsh/base';
import { language, t } from './i18n';
import { Icon } from './Icon';
import type { Message } from './model';
import type { NativeLocalCommandOutcome } from './composer-local-commands';
import { nativeTimelineRows } from './composer-timeline-model';

export type NativeTimelineOperation = { scope: string; type: 'revert' | 'fork'; messageID: string };
export type NativeComposerTimelineProps = {
  /** Actual Host generation + session + directory, not sidebar selection. */
  scope: string;
  open: boolean;
  active: boolean;
  /** Read only under Dialog presence; do not derive a second global history catalog. */
  messages: () => readonly Message[];
  canLoadEarlier: boolean;
  isLoadingEarlier: boolean;
  onLoadEarlier: () => Promise<boolean>;
  onScrollToMessage: (messageID: string) => Promise<boolean>;
  onRevertMessage: (messageID: string) => Promise<NativeLocalCommandOutcome>;
  onForkMessage: (messageID: string) => Promise<NativeLocalCommandOutcome>;
  canRevert: boolean;
  canFork: boolean;
  onScrollByTurnOffset?: (offset: -1) => void;
  onResumeToLatest?: () => void;
  onOpenChange: (open: boolean) => void;
  onUnknown: (operation: NativeTimelineOperation) => void;
  onOwner?: (owner: { settleUnknown: (operation: NativeTimelineOperation, outcome: 'accepted' | 'rejected') => boolean }) => void;
};

/** Native TimelineDialog, not a replacement action menu. Main retains history, mutation and navigation authority. */
export function NativeComposerTimeline(props: NativeComposerTimelineProps) {
  const query = signal(''), selected = signal(''), pending = signal<NativeTimelineOperation | null>(null), error = signal(false);
  let alive = true, unknown: NativeTimelineOperation | undefined, previousScope = props.scope;
  const current = (scope: string) => alive && props.scope === scope && props.active;
  const close = () => { if (current(props.scope)) props.onOpenChange(false); };
  effect(() => {
    const scope = props.scope;
    if (scope !== previousScope) untracked(() => { previousScope = scope; pending.set(null); unknown = undefined; query.set(''); selected.set(''); error.set(false); });
  });
  const settleUnknown = (operation: NativeTimelineOperation, outcome: 'accepted' | 'rejected') => {
    if (unknown !== operation || !current(operation.scope)) return false;
    unknown = undefined; pending.set(null); error.set(outcome === 'rejected');
    if (outcome === 'accepted') close(); return true;
  };
  props.onOwner?.({ settleUnknown });
  cleanup(() => { alive = false; });
  async function run(type: 'revert' | 'fork', messageID: string) {
    if (!props.open || !current(props.scope) || pending() || (type === 'revert' ? !props.canRevert : !props.canFork)
      || !props.messages().some(message => message.id === messageID && message.role === 'user')) return;
    const operation: NativeTimelineOperation = { scope: props.scope, type, messageID };
    pending.set(operation); error.set(false);
    let outcome: NativeLocalCommandOutcome;
    try { outcome = await (type === 'revert' ? props.onRevertMessage(messageID) : props.onForkMessage(messageID)); }
    catch { outcome = { status: 'unknown' }; }
    if (!alive || props.scope !== operation.scope || pending() !== operation) return;
    if (outcome?.status !== 'accepted' && outcome?.status !== 'rejected') { unknown = operation; error.set(true); props.onUnknown(operation); return; }
    pending.set(null);
    if (!current(operation.scope)) return;
    if (outcome.status === 'accepted') close(); else error.set(true);
  }
  function Body() {
    let present = true;
    cleanup(() => { present = false; });
    const scope = props.scope, focused = signal(false), composing = signal(false), loading = signal(false), list = signal<ListRef | undefined>(undefined);
    const rows = computed(() => nativeTimelineRows(props.messages(), query()));
    let visible = new Set<number>();
    let previousQuery: string | undefined, previousTail: string | undefined;
    const admitted = () => present && props.open && current(scope);
    const initialIndex = untracked(() => query().trim() ? 0 : Math.max(0, rows().length - 1));
    const reveal = (index: number) => {
      if (!admitted() || index < 0 || index >= rows().length || visible.has(index)) return;
      const first = Math.min(...visible);
      list()?.scrollToIndex({ index, animated: false, viewPosition: visible.size ? index < first ? 0 : 1 : .5 });
    };
    effect(() => {
      const values = rows(), search = query(), tail = values[values.length - 1]?.id;
      if (search !== previousQuery || tail !== previousTail) untracked(() => {
        const index = search.trim() ? 0 : values.length - 1; selected.set(values[index]?.id ?? '');
        if (previousQuery !== undefined) reveal(index);
      });
      previousQuery = search; previousTail = tail;
    });
    async function jump(messageID: string) {
      if (!admitted()) return;
      try { if (await props.onScrollToMessage(messageID) && admitted()) close(); }
      catch { if (admitted()) error.set(true); }
    }
    function navigate(direction: number) {
      const values = rows(); if (!values.length) return;
      const index = (Math.max(0, values.findIndex(row => row.id === selected())) + direction + values.length) % values.length;
      selected.set(values[index].id); reveal(index);
    }
    effect(() => {
      if (!admitted() || !focused() || composing()) return;
      cleanup(keymap.bind({ up: () => navigate(-1), down: () => navigate(1), enter: () => { const id = selected(); if (id) void jump(id); } }, { when: 'always', repeat: true }));
    });
    async function load() {
      if (!admitted() || loading() || props.isLoadingEarlier || !props.canLoadEarlier) return;
      loading.set(true); error.set(false);
      try { if (await props.onLoadEarlier() === false && admitted()) error.set(true); }
      catch { if (admitted()) error.set(true); }
      finally { if (present && alive && props.scope === scope) loading.set(false); }
    }
    const intlLocale = () => language() === 'system' ? locale() : language();
    const day = (created?: number) => created === undefined ? '' : new Date(created).toLocaleDateString(intlLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
    const time = (created?: number) => created === undefined ? '' : new Date(created).toLocaleTimeString(intlLocale(), { hour: 'numeric', minute: '2-digit' });
    return <View class="flex-1 min-h-0">
      <Text class="px-6 pt-4 pb-2 text-foreground" style={{ fontSize: 13, fontWeight: '500' }}>{t('chat.timeline.title')}</Text>
      <View class="mx-4 mb-2 px-2 flex-row items-center gap-2"><Icon name="search" size={16} /><Input testID="timeline-search" autoFocus class="flex-1 text-sm text-foreground" placeholder={t('chat.timeline.searchPlaceholder')} accessibilityLabel={t('chat.timeline.searchPlaceholder')}
        value={query()} onChange={event => query.set(event.value)} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
        onCompositionChange={event => composing.set(event.composing)} submitBehavior="submit" onSubmit={() => { if (!composing() && selected()) void jump(selected()); }} /></View>
      <If when={props.canLoadEarlier}><Button testID="timeline-load-earlier" class="self-center bg-transparent min-h-8 px-2" disabled={loading() || props.isLoadingEarlier} onPress={() => { void load(); }}><Text class="text-xs text-muted-foreground">{t('chat.history.loadOlder')}</Text></Button></If>
      <If when={error()}><Text testID="timeline-error" class="px-6 text-xs text-destructive">{t('common.unavailable')}</Text></If>
      <List testID="timeline-list" class="flex-1 min-h-0" each={rows()} keyExtractor={row => row.id} ref={node => list.set(node)} maintainVisibleContentPosition={{}}
        viewabilityConfig={{ itemVisibleThreshold: 1 }} onViewableItemsChange={info => { visible = new Set(info.viewableItems.filter(item => item.isViewable).map(item => item.index)); }}
        initialScrollIndex={initialIndex} style={{ backgroundColor: 'transparent' }}
        empty={<Text class="p-10 text-xs text-muted-foreground">{query() ? t('chat.timeline.empty.search') : t('chat.timeline.empty.session')}</Text>}>{row => {
        const date = () => day(row().created), showDate = () => row().index === 0 || day(row().previousCreated) !== date();
        return <View class="px-2">
          <If when={showDate()}><Text class="px-4 pt-3 pb-1 text-muted-foreground" style={{ fontSize: 11 }}>{date()}</Text></If>
          <View testID={`timeline-row-${row().id}`} class={`flex-row items-center gap-2 px-4 rounded-lg ${selected() === row().id ? 'bg-accent/40' : 'bg-transparent'}`} style={{ minHeight: 36 }} onMouseEnter={() => selected.set(row().id)}>
            <View testID={`timeline-jump-${row().id}`} role="button" accessibilityState={{ selected: selected() === row().id }} class="flex-1 flex-row items-center gap-3 py-2" onFocus={() => selected.set(row().id)} onPress={() => { void jump(row().id); }}>
              <Text class="text-muted-foreground" style={{ width: 68, fontSize: 10 }}>{time(row().created)}</Text>
              <Text class="flex-1 text-foreground" style={{ fontSize: 13, numberOfLines: 1 }}>{row().snippet ?? (row().preview || t('chat.timeline.noTextContent'))}</Text>
            </View>
            <View class="flex-row gap-1" style={{ opacity: selected() === row().id ? 1 : 0 }}>
              <If when={props.canRevert}><Button testID={`timeline-revert-${row().id}`} class="min-h-7 min-w-7 bg-transparent" disabled={!!pending()} accessibilityLabel={t('chat.timeline.actions.revertFromHere')} onPress={() => { void run('revert', row().id); }}><Icon name={pending()?.type === 'revert' && pending()?.messageID === row().id ? 'loader-4' : 'arrow-go-back'} size={16} /></Button></If>
              <If when={props.canFork}><Button testID={`timeline-fork-${row().id}`} class="min-h-7 min-w-7 bg-transparent" disabled={!!pending()} accessibilityLabel={t('chat.timeline.actions.forkFromHere')} onPress={() => { void run('fork', row().id); }}><Icon name={pending()?.type === 'fork' && pending()?.messageID === row().id ? 'loader-4' : 'git-branch'} size={16} /></Button></If>
            </View>
          </View>
        </View>;
      }}</List>
      <View class="flex-row justify-end gap-2 px-4 pt-1 pb-3">
        <If when={!!props.onScrollByTurnOffset}><Button testID="timeline-previous" class="bg-transparent min-h-7 px-2" disabled={!!pending()} onPress={() => { if (admitted()) { props.onScrollByTurnOffset?.(-1); close(); } }}><Text class="text-xs text-foreground">{t('chat.timeline.actions.previousTurn')}</Text></Button></If>
        <If when={!!props.onResumeToLatest}><Button testID="timeline-latest" class="bg-transparent min-h-7 px-2" disabled={!!pending()} onPress={() => { if (admitted()) { props.onResumeToLatest?.(); close(); } }}><Text class="text-xs text-foreground">{t('chat.timeline.actions.latest')}</Text></Button></If>
      </View>
    </View>;
  }
  return <If when={props.open && props.active}><Each of={[props.scope]} key={scope => scope}>{() => <Dialog testID="composer-timeline" open animation="fade" closeOnEscape closeOnBackdropPress
    class="bg-background rounded-2xl overflow-hidden" backdropClass="bg-background/50" style={{ position: 'absolute', width: '88%', maxWidth: 640, height: '80%', maxHeight: 672, alignSelf: 'center', top: '10%' }}
    onOpenChange={event => { if (!event.open) close(); }}><Body /></Dialog>}</Each></If>;
}
