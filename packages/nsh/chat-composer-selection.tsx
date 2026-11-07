import { cleanup, computed, effect, host, safeArea, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import { getProviderModelDisplayName } from '../ui/src/lib/modelDisplay';
import { formatEffortLabel, getAgentDisplayName, getCycledPrimaryAgentName, isPrimaryMode } from '../ui/src/components/chat/mobileControlsUtils';
import { LONG_PRESS_MOVE_PX, LONG_PRESS_MS } from '../ui/src/lib/touch-gestures/tap';
import { ChatModels } from './chat-models';
import { createModelPickerSheet } from './model-picker-presentation';
import { NativeAgentAvatar, NativeModelLogo, nativeAgentAccent } from './chat-identity';
import { t } from './i18n';
import { createPageOperations } from './page-operations';
import { assistantPath, query, sessionPath } from './runtime';
import { eventSessionID, list, record, runtimeEventFrom, text, unwrap, type ChatTarget, type Row } from './model';

export function NativeComposerSelection(props: {
  target: ChatTarget;
  active: boolean;
  open: 'model' | 'agent' | null;
  onOpenChange: (value: 'model' | 'agent' | null) => void;
  onAssistantEdit: () => void;
  onSelection?: (authority: Row) => void;
}) {
  const operations = createPageOperations(() => props.active);
  const selected = signal<Row>({}), providers = signal<Row[]>([]), agents = signal<Row[]>([]), error = signal('');
  const ready = signal(false), pending = signal(false), labelVisible = signal(false);
  const scope = { ...props.target };
  const sheet = createModelPickerSheet(() => props.onOpenChange(null));
  effect(() => { if (props.open === null) sheet.reset(); });
  let alive = true, serial = 0, page = 0, mutation = 0, suppressPress = false, hydrated = false;
  let timer: ReturnType<typeof setTimeout> | undefined, labelTimer: ReturnType<typeof setTimeout> | undefined, holdTimer: ReturnType<typeof setTimeout> | undefined;
  let touchOrigin: { x: number; y: number } | undefined;
  const current = (ticket = page) => alive && operations.current() && ticket === page && props.target.kind === scope.kind && props.target.id === scope.id && props.target.directory === scope.directory;
  const clearLabel = () => { if (labelTimer) clearTimeout(labelTimer); labelTimer = undefined; labelVisible.set(false); };
  const clearHold = () => { if (holdTimer) clearTimeout(holdTimer); holdTimer = undefined; };
  const cancelHold = () => { suppressPress = true; clearHold(); };
  function applyAuthority(authority: Row) {
    const previous = text(selected().agent), next = text(authority.agent);
    selected.set(authority);
    props.onSelection?.(authority);
    if (!hydrated) { hydrated = true; clearLabel(); return; }
    if (!previous || !next) { clearLabel(); return; }
    if (previous === next) return;
    clearLabel(); labelVisible.set(true);
    const ticket = page;
    // Same hold and symmetric expand/collapse duration as Web AgentCycleLabel.
    labelTimer = setTimeout(() => { labelTimer = undefined; if (current(ticket)) labelVisible.set(false); }, 1000);
  }
  async function load(withCatalog = false, preserveError = false): Promise<boolean> {
    if (!operations.current()) return false;
    const lane = operations.capture(), request = lane.request;
    const current = (ticket = page) => alive && lane.current() && ticket === page;
    const attempt = ++serial, ticket = page;
    try {
      const [value, catalog, agentCatalog] = await Promise.all([
        props.target.kind === 'session' ? request(`/api/session/${encodeURIComponent(props.target.id)}?${query(props.target.directory)}`) : request('/api/yuri/assistants/snapshot'),
        withCatalog ? request(`/api/config/catalog/providers?${query(props.target.directory)}`) : undefined,
        withCatalog ? request(`/api/agent?location%5Bdirectory%5D=${encodeURIComponent(props.target.directory)}`) : undefined,
      ]);
      if (!current(ticket) || attempt !== serial) return false;
      const authority = props.target.kind === 'session' ? record(unwrap(value)) : list(record(value).assistants).find(bot => bot.id === props.target.id);
      if (!authority || authority.id !== props.target.id) throw new Error(t('common.unavailable'));
      applyAuthority(authority);
      if (catalog !== undefined) {
        const body = record(catalog);
        if (body.schemaVersion !== 1 || !Array.isArray(body.providers)) throw new Error(t('common.unavailable'));
        providers.set(list(body.providers));
      }
      if (agentCatalog !== undefined) {
        if (!Array.isArray(unwrap(agentCatalog))) throw new Error(t('common.unavailable'));
        agents.set(list(unwrap(agentCatalog)).filter(agent => agent.hidden !== true && isPrimaryMode(typeof agent.mode === 'string' ? agent.mode : undefined) && text(agent.name)));
      }
      ready.set(true);
      if (!preserveError) error.set('');
      return true;
    } catch (cause) {
      if (current(ticket) && attempt === serial && !preserveError) error.set(cause instanceof Error ? cause.message : t('common.unavailable'));
      return false;
    }
  }
  effect(() => {
    const active = props.active && operations.current();
    page++; serial++; mutation++; hydrated = false; cancelHold(); pending.set(false); ready.set(false); clearLabel();
    if (timer) clearTimeout(timer); timer = undefined;
    if (active) void load(true); else props.onOpenChange(null);
  });
  const unsubscribe = host.on('runtime.event', payload => {
    const event = runtimeEventFrom(payload);
    if (!current() || timer || !event || event.directory && event.directory !== props.target.directory) return;
    if (event.type !== 'reconnected' && (!/^(session\.(updated|model\.|agent\.)|yuri:assistants-changed)/.test(event.type) || props.target.kind === 'session' && eventSessionID(event) !== props.target.id)) return;
    timer = setTimeout(() => { timer = undefined; void load(); }, 120);
  });
  cleanup(() => { alive = false; page++; serial++; mutation++; unsubscribe(); clearHold(); if (timer) clearTimeout(timer); if (labelTimer) clearTimeout(labelTimer); });
  const model = () => props.target.kind === 'session' ? record(selected().model) : { id: selected().modelID, providerID: selected().providerID, variant: selected().variant };
  const agent = () => text(selected().agent);
  const primaryAgents = computed(() => agents().map(agent => ({ name: text(agent.name), mode: agent.mode === 'primary' ? 'primary' as const : agent.mode === 'all' ? 'all' as const : undefined })));
  const agentLabel = () => agent() ? getAgentDisplayName(primaryAgents(), agent()) : t('chat.modelControls.selectAgent');
  const modelID = () => text(model().id);
  const providerID = () => text(model().providerID);
  const displayName = () => getProviderModelDisplayName(providers().find(provider => provider.id === providerID()), modelID());
  function open(mode: 'model' | 'agent') {
    if (!current()) return;
    if (props.target.kind === 'assistant') props.onAssistantEdit();
    else props.onOpenChange(mode);
  }
  async function cycleAgent() {
    if (!operations.current() || pending() || !ready() || props.open !== null) return;
    const lane = operations.capture(), request = lane.request;
    const current = (ticket = page) => alive && lane.current() && ticket === page;
    const next = getCycledPrimaryAgentName(primaryAgents(), agent());
    if (!next) return;
    const ticket = page, operation = ++mutation;
    pending.set(true); error.set('');
    try {
      if (props.target.kind === 'session') await request(`${sessionPath(props.target.id, 'agent')}?${query(props.target.directory)}`, 'POST', { agent: next });
      else {
        if (typeof selected().revision !== 'number') throw new Error(t('assistants.composer.selectionSaveFailed'));
        await request(assistantPath(props.target.id, '').replace(/\/$/, ''), 'PATCH', { expectedRevision: selected().revision, agent: next });
      }
      if (!current(ticket) || operation !== mutation) return;
      // A completed write is not the display authority; always read it back.
      if (!await load()) throw new Error(t('assistants.composer.selectionSaveFailed'));
    } catch (cause) {
      if (current(ticket) && operation === mutation) {
        error.set(cause instanceof Error ? cause.message : String(cause));
        await load(false, true);
      }
    } finally { if (current(ticket) && operation === mutation) pending.set(false); }
  }
  return <View class="flex-row items-center gap-1.5" style={{ flexShrink: 1, minWidth: 0 }}>
    <View focusable={false} onTouchStartCapture={event => { touchOrigin = { x: event.pageX, y: event.pageY }; }} onTouchMoveCapture={event => { if (event.touches.length > 1 || touchOrigin && Math.hypot(event.pageX - touchOrigin.x, event.pageY - touchOrigin.y) > LONG_PRESS_MOVE_PX) cancelHold(); }} onTouchCancel={cancelHold} onMouseLeave={cancelHold}>
    <Button testID="chat-agent-selection" class="flex-row items-center rounded-lg active:bg-accent disabled:opacity-40" style={{ height: 26, minHeight: 26, maxHeight: 26 }} hitSlop={6} disabled={pending() || !ready() || !props.active} accessibilityLabel={agent() || t('sessions.scheduledTasks.editor.agent.label')}
      onPressDown={() => { clearHold(); suppressPress = false; const ticket = page; holdTimer = setTimeout(() => { holdTimer = undefined; suppressPress = true; if (current(ticket) && !pending()) open('agent'); }, LONG_PRESS_MS); }} onPressUp={clearHold} onPress={() => { if (!suppressPress) void cycleAgent(); }}>
      <View class="items-center justify-center" style={{ width: 24, height: 26 }}><NativeAgentAvatar name={agent()} size={16} /></View>
      <View testID={labelVisible() ? 'chat-agent-cycle-label' : undefined} accessibilityElementsHidden={!labelVisible()} style={{ maxWidth: labelVisible() ? 160 : 0, opacity: labelVisible() ? 1 : 0, overflow: 'hidden', transitionProperty: 'all', transitionDuration: 280, transitionTimingFunction: 'ease-in-out' }}><Text class="text-xs pl-1 pr-0.5" style={{ color: nativeAgentAccent(agent()), numberOfLines: 1 }}>{agentLabel()}</Text></View>
    </Button>
    </View>
    <Button testID="chat-selection" class="max-w-36 flex-row items-center gap-1 rounded-lg active:bg-accent" style={{ height: 26, minHeight: 26, maxHeight: 26, flexShrink: 1, minWidth: 0 }} hitSlop={6} accessibilityLabel={`${displayName() || t('chat.modelControls.selectModel')}${text(model().variant) ? ` ${formatEffortLabel(text(model().variant))}` : ''}`} onPress={() => open('model')}>
      <NativeModelLogo modelID={modelID()} providerID={providerID()} size={16} />
      <Text class="text-foreground" style={{ fontSize: 11, lineHeight: 14, fontWeight: '500', maxWidth: 96, minWidth: 0, flexShrink: 1, numberOfLines: 1 }}>{error() || displayName() || t('sessions.scheduledTasks.editor.model.label')}</Text>
      <If when={!!model().variant}><Text class="text-muted-foreground" style={{ fontSize: 11, lineHeight: 14 }}>{formatEffortLabel(text(model().variant))}</Text></If>
    </Button>
    <Sheet detents={[.72, .98]} open={props.open !== null && props.active} closeOnSwipe onOpenChange={event => { if (!event.open) props.onOpenChange(null); }} popupClass="bg-background rounded-t-3xl" popupStyle={{ height: sheet.height() }} backdropClass="bg-background/50">
      <If when={props.open !== null && props.active}>
        <View class="flex-1" style={{ paddingBottom: safeArea().bottom }}><ChatModels target={props.target} initialTab={props.open || 'model'} embedded sheet={sheet} onDone={() => { props.onOpenChange(null); void load(); }} /></View>
      </If>
    </Sheet>
  </View>;
}
