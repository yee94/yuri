import { cleanup, computed, createMotion, effect, lifecycle, reduceMotion, safeArea, Scroll, signal, Text, token, View, windowSize } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { t } from './i18n';
import { record, text, type ChatTarget, type Row } from './model';
import { query } from './runtime';
import { captureHostRequest } from './state';
import { nativeMultiFileEntries, nativeToolDescription, nativeToolDetails, nativeToolDuration, type NativeToolFile } from './transcript-tools-model';
import { toolIconSpec } from '../ui/src/components/chat/message/parts/toolIconModel';
import { formatToolInput, resolveToolDisplayName } from '../ui/src/lib/toolHelpers';
import { NativeAgentAvatar } from './chat-identity';
import { Icon } from './Icon';
import { nativeChatTextStyle, nativeToolPaletteTokens } from './appearance';
import { nativeTranscriptMarkdownStyles } from './transcript-body-markdown';

export type NativeToolRowProps = {
  tool: Row;
  target: ChatTarget;
  /** Host generation + active chat fence; also checked before every navigation. */
  current: () => boolean;
  onOpenChat?: (target: ChatTarget) => void;
  onOpenFile?: (path: string, target: ChatTarget) => void;
  /** Patch is historical tool data, never substituted with the current working-tree diff. */
  onOpenDiff?: (file: NativeToolFile, target: ChatTarget, files: NativeToolFile[]) => void;
};
const action = 'min-h-9 px-2 py-1 rounded-lg active:bg-accent disabled:opacity-40 items-center justify-center';
const toolDisplayName = (name: string) => resolveToolDisplayName(name, t);
function RawToolText(props: { value: string; error?: boolean }) {
  return <TextView document={{ blocks: [{ type: 'codeBlock', code: props.value }] }} selectable codeBlockActions={[{ id: 'copy' }]} style={nativeChatTextStyle('assistant')} styles={nativeTranscriptMarkdownStyles('assistant')} class={props.error ? 'text-destructive' : 'text-foreground'} />;
}

/** Same 3×3, 12pt/2400ms wave as Web LatticeOrb, animated on the native thread. */
export function NativeToolOrb(props: { current: () => boolean; color?: string }) {
  return <View style={{ width: 12, height: 12 }}><Each of={[0, 1, 2, 3, 4, 5, 6, 7, 8]}>{index => {
    const x = index() % 3, y = Math.floor(index() / 3), center = x === 1 && y === 1;
    const motion = createMotion({ initial: { opacity: .16 } });
    effect(() => {
      if (!props.current() || lifecycle() !== 'active' || reduceMotion()) { motion.stop(); motion.opacity.set(center ? 1 : .16); return; }
      void motion.play({ keyframes: [{ offset: 0, opacity: .16 }, { offset: .35, opacity: 1 }, { offset: 1, opacity: .16 }], duration: 2400, delay: Math.hypot(x - 1, y - 1) * 700 - (center ? 180 : 0), iterations: 'infinite', easing: 'easeInOut' });
      return motion.stop;
    });
    cleanup(motion.stop);
    return <View style={{ position: 'absolute', left: (2 + x * 10) * 12 / 28, top: (2 + y * 10) * 12 / 28, width: 4 * 12 / 28, height: 4 * 12 / 28, borderRadius: 2, backgroundColor: props.color ?? String(token('muted-foreground')), opacity: motion.opacity }} />;
  }}</Each></View>;
}

export function NativeToolRow(props: NativeToolRowProps) {
  const request = captureHostRequest();
  const expanded = signal(false), failure = signal(''), pendingOpen = signal(false);
  let alive = true;
  cleanup(() => { alive = false; });
  const current = () => alive && props.current();
  const details = computed(() => nativeToolDetails(props.tool));
  const multi = computed(() => nativeMultiFileEntries(details()));
  const now = signal(Date.now());
  const active = () => details().active;
  const shell = () => ['bash', 'shell', 'cmd', 'terminal'].includes(details().name);
  const shellStyle = () => ({ ...nativeChatTextStyle('code'), lineHeight: 20 * (nativeChatTextStyle('code').fontSize ?? 13) / 13 });
  const rowStyle = () => ({ ...nativeChatTextStyle('meta'), lineHeight: 20 });
  const palette = nativeToolPaletteTokens;
  const failed = () => ['error', 'failed'].includes(details().status);
  const icon = () => toolIconSpec(details().name);
  const totals = computed(() => {
    const files = details().files;
    if (!files.some(file => file.additions !== undefined || file.deletions !== undefined)) return undefined;
    return { added: files.reduce((sum, file) => sum + (file.additions ?? 0), 0), removed: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) };
  });
  const navigation = () => (details().task && !!props.onOpenChat) || !!(details().files[0] && ['edit', 'multiedit', 'apply_patch', 'write', 'create', 'file_write', 'lsp'].includes(details().name));
  effect(() => {
    if (!current() || !shell() || !active() || lifecycle() !== 'active' || details().start === undefined || details().end !== undefined) return;
    const timer = setInterval(() => now.set(Date.now()), 250);
    return () => clearInterval(timer);
  });
  const title = () => details().agent ? details().agent!.charAt(0).toUpperCase() + details().agent!.slice(1) : (details().task && !details().sessionID && !['completed', 'error'].includes(details().status) ? t('chat.assistantStatus.delegatingTask') : toolDisplayName(details().name));
  function navigate(work: () => void) {
    if (!current()) return;
    failure.set('');
    try { work(); } catch (error) { if (current()) failure.set(error instanceof Error ? error.message : t('miniChat.actions.failed')); }
  }
  async function openChild() {
    if (!current()) return;
    const sessionID = details().sessionID;
    if (!sessionID) return;
    try {
      const response = record(await request(`/api/session/${encodeURIComponent(sessionID)}?${query(props.target.directory)}`));
      if (!current() || details().sessionID !== sessionID) return;
      const session = record(response.data ?? response);
      if (session.id !== sessionID) throw new Error(t('common.unavailable'));
      props.onOpenChat?.({ kind: 'session', id: sessionID, title: text(session.title) || details().title || sessionID, directory: text(session.directory) || props.target.directory });
    } catch (error) { if (current()) failure.set(error instanceof Error ? error.message : t('miniChat.actions.failed')); }
  }
  effect(() => {
    if (!pendingOpen() || !details().sessionID || !current()) return;
    pendingOpen.set(false); void openChild();
  });
  function mainPress() {
    if (!current()) return;
    const d = details(), first = d.files[0];
    if (d.task && props.onOpenChat) { if (d.sessionID) void openChild(); else pendingOpen.set(true); return; }
    if (first && ['edit', 'multiedit', 'apply_patch', 'write', 'create', 'file_write', 'lsp'].includes(d.name)) {
      if (props.onOpenDiff && (first.patch || first.before !== undefined || first.after !== undefined)) navigate(() => props.onOpenDiff?.(first, props.target, d.files));
      else if (props.onOpenFile) navigate(() => props.onOpenFile?.(first.path, props.target));
      return;
    }
    expanded.set(!expanded());
  }
  return <View class="gap-1 py-1">
    <View class="flex-row items-center gap-1">
      <Button testID={details().task && details().sessionID ? `tool-session-${details().sessionID}` : `tool-expand-${String(props.tool.id || details().name)}`} class={multi().length > 0 ? 'min-h-0 w-full min-w-0 flex-row flex-wrap flex-1 items-center rounded-lg py-0.5 active:bg-foreground/5' : 'min-h-0 flex-row flex-1 items-center gap-1.5 rounded-lg py-0.5 active:bg-foreground/5'} style={multi().length > 0 ? { columnGap: 8, rowGap: 2 } : undefined} hitSlop={8} disabled={!current()} onPress={mainPress} accessibilityLabel={title()}>
        <View class="items-center justify-center" style={{ width: 16, height: 16 }}><If when={details().task && !!(details().agent || details().sessionID)} else={<If when={active()} else={<Icon name={icon().name} size={icon().size} color={failed() ? palette()?.error : palette()?.icon} />}><NativeToolOrb current={current} color={palette()?.icon} /></If>}><NativeAgentAvatar name={details().sessionID || details().agent} size={14} /></If></View>
        <Text class={failed() ? 'text-destructive font-medium' : 'text-muted-foreground font-medium'} style={{ ...rowStyle(), color: failed() ? palette()?.error : palette()?.title, flexShrink: 0 }}>{title()}</Text>
        <If when={shell() && !!nativeToolDuration(details().start, details().end, active() ? now() : undefined)}><Text testID={`tool-duration-${String(props.tool.id || details().name)}`} class="text-muted-foreground" style={{ ...rowStyle(), opacity: .8 }}>{nativeToolDuration(details().start, details().end, active() ? now() : undefined)}</Text></If>
        <If when={multi().length > 0} else={<Text class="text-muted-foreground flex-1" style={{ ...rowStyle(), color: palette()?.description, numberOfLines: 1 }}>{nativeToolDescription(details(), props.target.directory)}</Text>}>
          <Each of={multi()} key={entry => entry.path}>{entry => <View class="flex-row items-center gap-1" style={{ maxWidth: '100%', flexShrink: 1, minWidth: 0 }}>
            <Text class="text-muted-foreground" style={{ ...rowStyle(), color: palette()?.description, flexShrink: 1, minWidth: 0, numberOfLines: 1 }}>{entry().name}</Text>
            <If when={entry().added !== null || entry().removed !== null}><View class="flex-row" style={{ flexShrink: 0 }}><Text class="text-success" style={rowStyle()}>+{entry().added ?? 0}</Text><Text class="text-muted-foreground" style={{ ...rowStyle(), color: palette()?.description }}>/</Text><Text class="text-destructive" style={rowStyle()}>-{entry().removed ?? 0}</Text></View></If>
          </View>}</Each>
        </If>
        <If when={multi().length === 0 && !!totals()}><View class="flex-row"><Text class="text-success" style={rowStyle()}>+{totals()!.added}</Text><Text class="text-muted-foreground" style={rowStyle()}>/</Text><Text class="text-destructive" style={rowStyle()}>-{totals()!.removed}</Text></View></If>
        <If when={details().todos.length > 0}><Text class="text-muted-foreground" style={rowStyle()}>{details().todos.filter(todo => todo.status === 'completed' || todo.status === 'cancelled').length}/{details().todos.length}</Text></If>
        <If when={!navigation()}><Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></If>
      </Button>
      <If when={navigation() && details().task}><Button testID={`tool-details-${String(props.tool.id || details().name)}`} class="min-h-0 h-6 w-6 items-center justify-center rounded-lg active:bg-accent" hitSlop={8} accessibilityLabel={t('chat.toolPart.output')} disabled={!current()} onPress={() => expanded.set(!expanded())}><Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></Button></If>
    </View>
    <If when={expanded()}>
      <If when={shell()}><View selectable class="ml-2 pl-3 border-l border-border py-1 gap-0.5">
        <If when={!!details().command || !!details().streamingInput}><Scroll class="max-h-60">
          <Text testID={`tool-shell-input-${String(props.tool.id || details().name)}`} class="text-muted-foreground" style={shellStyle()}>{details().command || details().streamingInput}</Text>
        </Scroll></If>
        <If when={!!details().output}><Scroll style={{ maxHeight: Math.max(0, windowSize().height - safeArea().top - safeArea().bottom) * .46 }}>
          <Text testID={`tool-shell-output-${String(props.tool.id || details().name)}`} class="text-foreground" style={shellStyle()}>{details().output.replace(/[\r\n]+$/, '')}</Text>
        </Scroll></If>
        <If when={!details().slim && !details().output && details().status === 'completed'}><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('chat.toolPart.noOutputProduced')}</Text></If>
        <If when={!!details().error}><View class="gap-1">
          <Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('chat.toolPart.error')}</Text>
          <Text class="text-destructive" style={shellStyle()}>{details().error}</Text>
        </View></If>
      </View></If>
      <If when={!shell()}>
    <Each of={details().files} key={file => file.path}>{file => <View class="gap-1">
      <Text class="text-sm text-foreground">{file().path}{file().additions === undefined ? '' : ` +${file().additions}`}{file().deletions === undefined ? '' : ` −${file().deletions}`}</Text>
      <View class="flex-row flex-wrap gap-2">
        <If when={!!props.onOpenFile}><Button class={action} disabled={!current()} onPress={() => navigate(() => props.onOpenFile?.(file().path, props.target))}><Text class="text-foreground">{t('chat.toolPart.openFileAtFirstChange')}</Text></Button></If>
        <If when={!!props.onOpenDiff && !!(file().patch || file().before !== undefined || file().after !== undefined)}><Button class={action} disabled={!current()} onPress={() => navigate(() => props.onOpenDiff?.(file(), props.target, details().files))}><Text class="text-foreground">{t('chat.toolPart.openFileDiff')}</Text></Button></If>
      </View>
    </View>}</Each>
      <Scroll style={{ maxHeight: Math.max(0, windowSize().height - safeArea().top - safeArea().bottom) * .4 }} contentClass="ml-2 pl-3 border-l border-border py-1 gap-2">
        <If when={!navigation() && !details().todos.length && !details().task && Object.keys(details().input).length > 0}><Text class="text-muted-foreground italic" style={{ ...rowStyle(), opacity: .7 }}>{typeof details().input.content === 'string' ? text(details().input.content) : formatToolInput(details().input, details().name)}</Text></If>
        <If when={!!details().streamingInput}><RawToolText value={details().streamingInput} /></If>
        <Each of={details().todos}>{todo => <Text class="text-sm text-foreground">{todo().status === 'completed' ? '✓ ' : todo().status === 'in_progress' ? '◉ ' : '○ '}{String(todo().content || '')}</Text>}</Each>
        <Each of={details().summary}>{entry => <View class="flex-row items-center gap-1.5"><Icon name={toolIconSpec(entry().tool || 'tool').name} size={14} color={palette()?.icon} /><Text class="text-muted-foreground" style={rowStyle()}>{toolDisplayName(entry().tool || 'tool')}</Text><Text class="text-muted-foreground flex-1" style={{ ...rowStyle(), numberOfLines: 1 }}>{entry().state?.title}</Text></View>}</Each>
        <If when={!!details().output && !details().todos.length}><If when={details().task} else={<RawToolText value={details().output} />}><TextView markdown={details().output} selectable links="open" style={rowStyle()} styles={nativeTranscriptMarkdownStyles('assistant')} /></If></If>
        <If when={!details().slim && !details().output && details().status === 'completed'}><Text class="text-xs text-muted-foreground">{t('chat.toolPart.noOutputProduced')}</Text></If>
        <If when={!!details().error}><Text class="text-muted-foreground font-medium" style={rowStyle()}>{t('chat.toolPart.error')}</Text><View selectable class="p-2 rounded-xl bg-destructive/10"><Text class="text-destructive" style={rowStyle()}>{details().error}</Text></View></If>
      </Scroll>
      </If>
    </If>
    <If when={navigation() && !details().task && !!details().error}><View selectable class="ml-2 pl-3 border-l border-border py-1"><Text class="text-destructive" style={rowStyle()}>{details().error}</Text></View></If>
    <If when={!!failure()}><Text class="text-sm text-destructive">{failure()}</Text></If>
  </View>;
}
