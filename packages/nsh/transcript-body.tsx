import { computed, effect, Scroll, signal, Text, token, untracked, View, windowSize, type JSX } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { nativeAppearance, nativeAgentPaletteTokens, nativeChatSurfaceStyle, nativeChatTextStyle } from './appearance';
import { t } from './i18n';
import { record, text, type ChatTarget, type Row } from './model';
import { Icon } from './Icon';
import { NativeToolOrb, NativeToolRow, type NativeToolRowProps } from './transcript-tools';
import type { NativeToolFile } from './transcript-tools-model';
import { NativeAutoReadBody, type NativeAutoRead } from './native-auto-read';
import { nativeBodyPlan, nativeMessageEntry, nativeMessageRole, type NativeBodyNode, type NativeBodyPart, type NativeBodyRow } from './transcript-body-model';
import { PROCESS_TOOL_COUNT_ORDER } from '../ui/src/components/chat/message/parts/processToolGrouping';
import { formatActivityDuration } from '../ui/src/components/chat/message/parts/formatActivityDuration';
import { nativeTranscriptMarkdownStyles } from './transcript-body-markdown';
import { isRestartNotice } from '../ui/src/components/chat/message/assistantErrorPresentation';
import { getReasoningSummary, initialReasoningExpansion, reconcileReasoningExpansion, type ReasoningExpansionState } from '../ui/src/components/chat/message/parts/reasoningPresentation';
import { nativeReasoningPresentation } from './chat-preferences-core';
import { NativeAgentAvatar } from './chat-identity';
import type { ActivityMaterialization } from './transcript-materialization';

type ProcessNode = Extract<NativeBodyNode, { kind: 'process' }>;
type ToolGroupNode = Extract<NativeBodyNode, { kind: 'process' | 'skill' }>;
type BodyProps = Omit<NativeToolRowProps, 'tool' | 'onOpenDiff'> & {
  onOpenDiff?: (file: NativeToolFile, target: ChatTarget, messageID: string, files: NativeToolFile[]) => void;
  autoRead?: NativeAutoRead;
  autoReadScope?: string;
  streaming?: boolean;
  row: NativeBodyRow;
  live?: boolean;
  collapsibleUserMessages?: boolean | null;
  activityChoice?: boolean;
  activityMaterialization?: ActivityMaterialization;
  onToggleActivity?: (turnID: string, expanded: boolean) => void;
  renderCard: (card: Row) => JSX.Element;
};
function summary(node: ProcessNode) {
  return PROCESS_TOOL_COUNT_ORDER.filter(key => node.counts[key] > 0).map(key => {
    const count = node.counts[key];
    switch (key) {
      case 'search': return t(count === 1 ? 'chat.contextGroup.searchSingle' : 'chat.contextGroup.searchPlural', { count });
      case 'read': return t(count === 1 ? 'chat.contextGroup.readSingle' : 'chat.contextGroup.readPlural', { count });
      case 'list': return t(count === 1 ? 'chat.contextGroup.listSingle' : 'chat.contextGroup.listPlural', { count });
      case 'edit': return t(count === 1 ? 'chat.usedGroup.editSingle' : 'chat.usedGroup.editPlural', { count });
      case 'command': return t(count === 1 ? 'chat.usedGroup.commandSingle' : 'chat.usedGroup.commandPlural', { count });
      default: return t(count === 1 ? 'chat.usedGroup.otherSingle' : 'chat.usedGroup.otherPlural', { count });
    }
  }).join(', ');
}
function DiffTotals(props: { added: number; removed: number }) {
  return <If when={props.added > 0 || props.removed > 0}><View class="flex-row items-center gap-0.5">
    <If when={props.added > 0}><Text class="text-success" style={nativeChatTextStyle('meta')}>+{props.added}</Text></If>
    <If when={props.added > 0 && props.removed > 0}><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>/</Text></If>
    <If when={props.removed > 0}><Text class="text-destructive" style={nativeChatTextStyle('meta')}>-{props.removed}</Text></If>
  </View></If>;
}
function ToolGroup(props: { node: ToolGroupNode; body: BodyProps }) {
  const expanded = signal(false);
  const skill = () => props.node.kind === 'skill';
  const description = () => props.node.kind === 'process' ? summary(props.node) : props.node.names.hiddenCount > 0 ? t('chat.skillGroup.summaryOverflow', { names: props.node.names.joinedVisible, count: props.node.names.hiddenCount }) : props.node.names.joinedVisible;
  const diffs = () => props.node.kind === 'process' ? props.node.diffs : undefined;
  return <View class="gap-2">
    <Button testID={`body-${props.node.key}`} class="min-h-0 h-5 flex-row items-center gap-1.5 active:bg-accent" hitSlop={8}
      accessibilityLabel={t(skill() ? expanded() ? 'chat.skillGroup.collapseAria' : 'chat.skillGroup.expandAria' : expanded() ? 'chat.usedGroup.collapseAria' : 'chat.usedGroup.expandAria')}
      onPress={() => { if (props.body.current()) expanded.set(!expanded()); }}>
      <View class="items-center justify-center" style={{ width: 16, height: 16 }}><If when={props.node.active} else={<Icon name={skill() ? 'book' : 'search'} size={14} />}><NativeToolOrb current={props.body.current} /></If></View>
      <Text testID={`body-${props.node.key}-${props.node.active ? 'active' : 'settled'}`} class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t(skill() ? 'chat.tools.display.skill' : props.node.active ? 'chat.usedGroup.running' : 'chat.usedGroup.used')}</Text>
      <Text class="text-muted-foreground flex-1" style={{ ...nativeChatTextStyle('meta'), numberOfLines: 1 }}>{description()}</Text>
      <DiffTotals added={diffs()?.added ?? 0} removed={diffs()?.removed ?? 0} />
      <View style={{ width: 14, height: 14, flexShrink: 0 }}><Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></View>
    </Button>
    <If when={expanded()}><View class="ml-2 pl-3 border-l border-border gap-1 pt-1">
      <Each of={props.node.parts} key={part => part.key}>{part => <Tool part={part()} body={props.body} />}</Each>
    </View></If>
  </View>;
}
function Tool(props: { part: NativeBodyPart; body: BodyProps }) {
  return <NativeToolRow tool={props.part.source} target={props.body.target} current={props.body.current}
    onOpenChat={target => props.body.onOpenChat?.(target)} onOpenFile={(path, target) => props.body.onOpenFile?.(path, target)}
    onOpenDiff={(file, target, files) => props.body.onOpenDiff?.(file, target, props.part.messageID, files)} />;
}
function Reasoning(props: { part: NativeBodyPart; body: BodyProps; inActivity: boolean }) {
  const presentation = computed(() => nativeReasoningPresentation(text(props.part.source.text), nativeAppearance.current()?.collapsibleThinkingBlocks, props.inActivity));
  return <If when={!!presentation().content.trim()}>
    <If when={presentation().collapsible} else={<TextView testID={`body-part-${props.part.key}`} markdown={presentation().content} selectable links="open" options={{ streaming: true }}
      class="text-muted-foreground" style={nativeChatTextStyle('assistant')} styles={nativeTranscriptMarkdownStyles('assistant')} codeBlockActions={[{ id: 'copy' }]} />}>
      <CollapsibleReasoning part={props.part} body={props.body} content={presentation().content} />
    </If>
  </If>;
}
function CollapsibleReasoning(props: { part: NativeBodyPart; body: BodyProps; content: string }) {
  const content = () => props.content;
  const preview = computed(() => getReasoningSummary(content()));
  const streaming = () => nativeAppearance.current()?.chatRenderMode === 'live' && props.body.streaming === true && props.part.messageID === props.body.row.tail.id && typeof record(props.part.source.time).end !== 'number';
  const choice = signal<{ key: string; expansion: ReasoningExpansionState }>({ key: props.part.key, expansion: initialReasoningExpansion(undefined, streaming()) });
  effect(() => {
    const key = props.part.key, active = streaming();
    untracked(() => {
      const previous = choice();
      const next = previous.key === key ? reconcileReasoningExpansion(previous.expansion, active) : initialReasoningExpansion(undefined, active);
      if (previous.key !== key || previous.expansion !== next) choice.set({ key, expansion: next });
    });
  });
  const expanded = () => choice().key === props.part.key && choice().expansion.expanded;
  const body = () => <TextView testID={`body-part-${props.part.key}`} markdown={content()} selectable links="open" options={{ streaming: true }}
    class="text-muted-foreground" style={nativeChatTextStyle('assistant')} styles={nativeTranscriptMarkdownStyles('assistant')} codeBlockActions={[{ id: 'copy' }]} />;
  return <If when={!!content()}><View class="gap-1">
    <Button testID={`body-reasoning-${props.part.key}`} class="min-h-0 h-5 flex-row items-center gap-1.5 active:bg-accent" hitSlop={8}
      accessibilityLabel={t(expanded() ? 'chat.reasoningTrace.collapseAria' : 'chat.reasoningTrace.expandAria')}
      onPress={() => { if (props.body.current()) choice.set({ key: props.part.key, expansion: { expanded: !expanded(), source: 'user' } }); }}>
      <Icon name={expanded() ? 'arrow-down-s' : 'brain-ai-3'} size={14} />
      <Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t(streaming() || expanded() ? 'chat.reasoningTrace.thinking' : 'chat.reasoningTrace.thought')}</Text>
      <If when={!streaming() && !expanded()}><Text class="text-muted-foreground flex-1" style={{ ...nativeChatTextStyle('meta'), minWidth: 0, numberOfLines: 1 }}>{preview()}</Text></If>
    </Button>
    <If when={expanded()}><View class="ml-2 pl-3 border-l border-border pt-0.5 pb-1">
      <If when={streaming()} else={<Scroll style={{ maxHeight: 320 }}>{body()}</Scroll>}>{body()}</If>
    </View></If>
  </View></If>;
}
type UserClamp = (key: string, value: boolean) => void;
function collapsePreference(props: BodyProps): boolean | null {
  if (props.collapsibleUserMessages !== undefined) return props.collapsibleUserMessages;
  const snapshot = nativeAppearance.current();
  if (!snapshot || !('collapsibleUserMessages' in snapshot)) return null;
  return typeof snapshot.collapsibleUserMessages === 'boolean' ? snapshot.collapsibleUserMessages : null;
}
function UserText(props: { part: NativeBodyPart; enabled: boolean; current: () => boolean; onClamp: UserClamp }) {
  const choice = signal<{ key: string; expanded: boolean } | null>(null);
  const measured = signal<{ key: string; source: string; height: number } | null>(null);
  const expanded = () => props.enabled && choice()?.key === props.part.key && choice()!.expanded;
  const limit = () => { const height = nativeChatTextStyle('user').lineHeight; return height === undefined ? undefined : height * 10; };
  const overflow = () => {
    const value = measured(), height = limit();
    return value?.key === props.part.key && value.source === text(props.part.source.text) && height !== undefined && value.height > height + .5;
  };
  const clamped = () => props.enabled && !expanded();
  effect(() => {
    if (!props.enabled) untracked(() => choice.set(null));
    const key = props.part.key, hidden = clamped() && overflow();
    untracked(() => props.onClamp(key, hidden));
  });
  return <View style={{ position: 'relative', paddingBottom: expanded() ? 12 : 0 }}>
    <View testID={`user-text-viewport-${props.part.key}`} style={{ maxHeight: clamped() ? limit() : undefined, overflow: clamped() ? 'hidden' : 'visible' }}>
      <TextView testID={`body-part-${props.part.key}`} markdown={text(props.part.source.text)} selectable links="open" options={{ streaming: true }}
        class="text-foreground" style={{ ...nativeChatTextStyle('user'), flexShrink: 0 }} styles={nativeTranscriptMarkdownStyles('user', clamped())}
        onLayout={event => measured.set({ key: props.part.key, source: text(props.part.source.text), height: event.bounds.size.height })}
        codeBlockActions={[{ id: 'copy' }]} />
    </View>
    <If when={clamped() && overflow()}><Button testID={`user-show-more-${props.part.key}`} class="min-h-0 flex-row items-center gap-1" style={{ alignSelf: 'flex-start' }}
      accessibilityLabel={t('chat.message.userText.showMore')} onPress={() => { if (props.current()) choice.set({ key: props.part.key, expanded: true }); }}>
      <Text class="text-muted-foreground" style={{ ...nativeChatTextStyle('user'), color: token('muted-foreground') }}>{t('chat.message.userText.showMore')}</Text>
      <View style={{ width: 14, height: 14, flexShrink: 0 }}><Icon name="arrow-down-s" size={14} /></View>
    </Button></If>
    <If when={expanded()}><Button testID={`user-collapse-${props.part.key}`} class="min-h-0 min-w-0 bg-card rounded-sm items-center justify-center" style={{ position: 'absolute', top: 0, right: 0, width: 18, height: 18, padding: 2 }} hitSlop={8}
      accessibilityLabel={t('chat.message.userText.collapseAria')} onPress={() => { if (props.current()) choice.set({ key: props.part.key, expanded: false }); }}>
      <Icon name="arrow-up-s" size={14} />
    </Button></If>
  </View>;
}
function Part(props: { part: NativeBodyPart; body: BodyProps; inActivity: boolean; filesHidden: boolean; onClamp: UserClamp }) {
  const role = () => nativeMessageRole(props.body.row.head) === 'user' ? 'user' as const : 'assistant' as const;
  return <View>
    <If when={props.part.source.type === 'reasoning'}><Reasoning part={props.part} body={props.body} inActivity={props.inActivity} /></If>
    <If when={props.part.source.type === 'text'}>
      <View class={role() === 'user' ? 'items-end' : ''}>
        <View class={role() === 'user' ? 'bg-chat-user rounded-xl px-3 py-1.5' : ''}
          style={role() === 'user' ? { ...nativeChatSurfaceStyle('user'), width: 'max-content', maxWidth: Math.max(0, windowSize().width - 24) * .85 } : undefined}>
          <If when={role() === 'user'} else={<TextView testID={`body-part-${props.part.key}`} markdown={text(props.part.source.text)} selectable links="open" options={{ streaming: true }}
            class={props.part.source.type === 'reasoning' ? 'text-muted-foreground' : 'text-foreground'}
            style={nativeChatTextStyle(role())} styles={nativeTranscriptMarkdownStyles(role())} codeBlockActions={[{ id: 'copy' }]} />}>
            <UserText part={props.part} enabled={collapsePreference(props.body) === true} current={props.body.current} onClamp={props.onClamp} />
          </If>
        </View>
      </View>
    </If>
    <If when={props.part.source.type === 'tool'}><Tool part={props.part} body={props.body} /></If>
    <If when={props.part.source.type === 'card' || props.part.source.type === 'compaction'}>{props.body.renderCard(props.part.source)}</If>
    <If when={props.part.source.type === 'file' && !(role() === 'user' && props.filesHidden)}><View class="bg-card rounded-xl p-3">
      <Text class="text-foreground" style={nativeChatTextStyle('meta')}>{text(props.part.source.name) || text(props.part.source.filename) || t('chat.chatInput.fileFallback')}</Text>
      <Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{text(props.part.source.mime)}</Text>
    </View></If>
  </View>;
}
function Nodes(props: { nodes: NativeBodyNode[]; body: BodyProps; inActivity?: boolean; filesHidden?: boolean; onClamp?: UserClamp }) {
  return <Each of={props.nodes} key={node => node.key}>{node => <View>
    <If when={node().kind !== 'part'}><ToolGroup node={node() as ToolGroupNode} body={props.body} /></If>
    <If when={node().kind === 'part'}><Part part={(node() as Extract<NativeBodyNode, { kind: 'part' }>).part} body={props.body} inActivity={props.inActivity === true} filesHidden={props.filesHidden === true} onClamp={(key, value) => props.onClamp?.(key, value)} /></If>
  </View>}</Each>;
}
/** One body owner per real assistant run; content order and source identities remain authoritative. */
export function NativeTranscriptBody(props: BodyProps) {
  const plan = computed(() => { const appearance = nativeAppearance.current(); return nativeBodyPlan(props.row, {
    live: props.live, showReasoning: appearance?.showReasoningTraces, mode: appearance?.chatRenderMode, activityMode: appearance?.activityRenderMode,
  }); });
  // An explicit choice survives a new streamed part/default change, but never another virtualized identity.
  const choice = signal<{ key: string; expanded: boolean } | null>(null);
  const userClamps = signal<{ row: string; keys: string[] }>({ row: props.row.key, keys: [] });
  function setUserClamp(key: string, value: boolean) {
    const row = props.row.key, current = userClamps();
    const active = new Set(plan().inline.filter(node => node.kind === 'part').map(node => node.key));
    const keys = current.row === row ? current.keys.filter(entry => active.has(entry)) : [];
    if (keys.includes(key) === value && current.row === row) return;
    userClamps.set({ row, keys: value ? [...keys, key] : keys.filter(entry => entry !== key) });
  }
  const turnID = () => props.row.turn?.turnId ?? props.row.key;
  const expanded = () => plan().locked || (props.activityChoice ?? (choice()?.key === turnID() ? choice()!.expanded : plan().defaultExpanded));
  const agents = () => plan().active ? plan().header.agents.active : plan().header.agents.all;
  const requested = signal<{ turn: string; ids: readonly string[] }>({ turn: turnID(), ids: [] });
  const requestedIDs = () => requested().turn === turnID() ? requested().ids : [];
  function requestOutput(automatic = false, retryErrorsOnly = false) {
    if (!props.current() || plan().active || !props.activityMaterialization) return;
    const ids = [...new Set([...requestedIDs(), ...plan().materializationMessageIDs])];
    if (requested().turn !== turnID() || ids.length !== requestedIDs().length) requested.set({ turn: turnID(), ids });
    void props.activityMaterialization.request(ids, { automatic, retryErrorsOnly });
  }
  const fill = () => props.activityMaterialization?.state(requestedIDs());
  effect(() => {
    const shouldFill = expanded() && !plan().active && props.current();
    plan().materializationMessageIDs;
    if (shouldFill) untracked(() => requestOutput(true));
  });
  return <View testID={`turn-body-${props.row.key}`} class="gap-2">
    <If when={isRestartNotice(nativeMessageEntry(props.row.head).info)}><View class="flex-row items-center gap-2"><Icon name="restart" size={14} /><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('chat.response.continuingAfterRestart')}</Text></View></If>
    <If when={plan().hasActivity}>
      <If when={!plan().locked || plan().compaction}>
      <Button testID={`body-activity-${props.row.key}`} class="min-h-0 h-5 flex-row items-center gap-1.5 active:bg-accent" hitSlop={8}
        accessibilityLabel={t(expanded() ? 'chat.activity.collapseAria' : 'chat.activity.expandAria')}
        disabled={plan().locked} onPress={() => { if (!props.current() || plan().locked) return; if (!expanded()) requestOutput(); if (props.onToggleActivity) props.onToggleActivity(turnID(), !expanded()); else choice.set({ key: turnID(), expanded: !expanded() }); }}>
        <If when={plan().compaction}><Icon name="fold-vertical" size={14} /></If>
        <Text class="text-muted-foreground" style={{ ...nativeChatTextStyle('meta'), color: plan().compaction && plan().active ? nativeAgentPaletteTokens()['--status-info'] : undefined, flexShrink: 1, minWidth: 0, numberOfLines: 1 }}>{plan().compaction ? t(plan().active ? 'chat.activity.compacting' : 'chat.activity.compactionCompleted') : plan().durationMs !== undefined ? t('chat.activity.completed', { duration: formatActivityDuration(plan().durationMs!) }) : t('chat.activity.completedStatus')}</Text>
        <If when={!plan().locked && !plan().compaction}><View testID={`body-activity-arrow-${props.row.key}`} style={{ width: 14, height: 14, flexShrink: 0 }}><Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></View></If>
        <If when={plan().compaction && !plan().active && plan().durationMs !== undefined}><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{formatActivityDuration(plan().durationMs!)}</Text></If>
        <View class="flex-1" />
        <If when={agents().length > 0}><View testID={`activity-agents-${props.row.key}`} class="flex-row items-center gap-1" style={{ maxWidth: windowSize().width * .4 }}>
          <View class="flex-row gap-0.5"><Each of={agents().slice(0, 2)} key={seed => seed}>{seed => <View testID={`activity-agent-${seed()}`}><NativeAgentAvatar name={seed()} size={12} /></View>}</Each></View>
          <Text class="text-muted-foreground" style={{ ...nativeChatTextStyle('meta'), numberOfLines: 1, flexShrink: 1 }}>{t(plan().active ? 'chat.activity.agentsWorking' : 'chat.activity.agentsInvolved', { count: agents().length })}</Text>
        </View></If>
        <DiffTotals added={plan().header.diffs.added} removed={plan().header.diffs.removed} />
        <If when={!plan().locked && plan().compaction}><View testID={`body-activity-arrow-${props.row.key}`} style={{ width: 14, height: 14, flexShrink: 0 }}><Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></View></If>
      </Button>
      </If>
      <If when={expanded() && plan().activity.length > 0}><View class={plan().locked ? 'gap-2' : 'ml-2 pl-3 border-l border-border gap-2'}><Nodes nodes={plan().activity} body={props} inActivity /></View></If>
      <If when={expanded() && (fill()?.loading || fill()?.failed || fill()?.empty)}><View testID={`activity-fill-${props.row.key}`} role={fill()?.failed ? 'alert' : undefined} class="min-h-9 ml-5 flex-row items-center gap-2">
        <If when={fill()?.loading} else={<If when={fill()?.failed} else={<Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('chat.toolOutputDialog.noOutputProduced')}</Text>}>
          <Text class="text-destructive flex-1" style={nativeChatTextStyle('meta')}>{t('chat.activity.outputLoadFailed')}</Text>
          <Button testID={`activity-fill-retry-${props.row.key}`} class="min-h-9 px-2 rounded-lg active:bg-accent" onPress={() => requestOutput(false, true)}><Text class="text-foreground" style={nativeChatTextStyle('meta')}>{t('chat.activity.outputRetry')}</Text></Button>
        </If>}><NativeToolOrb current={props.current} /><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('chat.activity.outputLoading')}</Text></If>
      </View></If>
    </If>
    <If when={!plan().foldInline || expanded()}><Nodes nodes={plan().inline} body={props} filesHidden={userClamps().row === props.row.key && plan().inline.some(node => node.kind === 'part' && userClamps().keys.includes(node.key))} onClamp={setUserClamp} /></If>
    <If when={!!props.autoRead && !!props.autoReadScope}><NativeAutoReadBody autoRead={props.autoRead!} scope={props.autoReadScope!} sessionID={props.target.id} row={props.row} plan={plan()} streaming={props.streaming === true} /></If>
  </View>;
}
