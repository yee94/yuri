import { cleanup, computed, host, List, mount, Overlay, platform, signal, Text, View, windowSize, type Bounds, type InputRef, type ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeDesktopChatEmptyState, desktopChatEditorStyle, desktopChatListContentStyle } from './desktop-chat-layout';
import { NativeComposerSend } from './composer-send';
import { desktopChatContentWidth } from './desktop-chat-layout-core';
import { createNativeHistoryRows } from './history-rows';
import { messageFrom, type Row } from './model';
import { NativeTranscriptBody } from './transcript-body';
import { NativeTurnHeader } from './transcript-tools-turn';
import { Icon } from './Icon';
import { language, t } from './i18n';
import { NativeChatBodyLayout, NativeChatComposerLayout, NativeChatRow } from './chat-layout-surfaces';
import { createChatChromeState } from './chat-chrome';

language.set('en');
function Fixture() {
  const draft = signal(''), interactive = signal(true), status = signal(false), panel = signal(false), mode = signal('history'), wide = signal(false);
  const calls = signal(0), focused = signal(false), result = signal(''), measuredWidth = signal(0);
  const slotMode = signal('hidden'), requestedReserve = signal<number | undefined>(undefined), metadata = signal(0);
  const reserve = () => requestedReserve() ?? (slotMode() === 'inline' ? 210 : 0);
  const bodyBounds = signal<Bounds>({ origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } });
  const chrome = createChatChromeState();
  let editor: InputRef | undefined, anchor: ViewRef | undefined, transcript: ViewRef | undefined, main: ViewRef | undefined;
  let body: ViewRef | undefined, statusProbe: ViewRef | undefined, userContent: ViewRef | undefined;
  let editorMounts = 0, transcriptMounts = 0, rowComputations = 0;
  let editorRefs = 0, listRefs = 0, bodyRefs = 0, bodyLayouts = 0, bodyMeasures = 0, slotProjections = 0, sequence = 0;
  function StatusSlot() {
    const projected = computed(() => { slotProjections++; return `Synthetic status ${metadata()}`; });
    cleanup(() => { statusProbe = undefined; });
    return <If when={slotMode() === 'overlay'} else={<View testID="layout-status-slot" ref={view => { statusProbe = view; }} style={{ position: 'absolute', right: 14, top: 8, width: 196, height: 80 }}><Text>{projected()}</Text></View>}>
      <Overlay testID="layout-status-popup" ref={view => { statusProbe = view; }} style={{ left: bodyBounds().origin.x + bodyBounds().size.width - 14 - 264, top: bodyBounds().origin.y + 12, width: 264, height: 80 }}><Text>{projected()}</Text></Overlay>
    </If>;
  }
  async function bodyLayout() {
    bodyLayouts++;
    if (!body) return;
    bodyMeasures++;
    const measured = await body.measure();
    if (measured) bodyBounds.set({ origin: measured.pagePosition, size: measured.bounds.size });
  }
  host.on<{ action: string; value?: string | number }>('layout.control', event => {
    if (event.action === 'slot') slotMode.set(String(event.value));
    else if (event.action === 'reserve') requestedReserve.set(event.value === 'auto' ? undefined : event.value === 'nan' ? NaN : event.value === 'infinity' ? Infinity : Number(event.value));
    else if (event.action === 'metadata') metadata.set(Number(event.value));
    else if (event.action === 'snapshot') result.set(JSON.stringify({ sequence: ++sequence, bodyRefs, bodyLayouts, bodyMeasures, slotProjections, editorRefs, listRefs, rowComputations, editorMounts, transcriptMounts }));
    else throw new Error('Unknown layout fixture control');
  });
  function Editor() {
    editorMounts++;
    return <Input testID="composer" ref={ref => { editor = ref; editorRefs++; }} multiline readonly={!interactive()} value={draft()}
      placeholder={t('chat.chatInput.placeholder.chatCompact')} submitBehavior="submit" onSubmit={() => { if (interactive()) calls.set(calls() + 1); }}
      class="text-foreground" style={{ fontSize: 14, lineHeight: 20, ...desktopChatEditorStyle }} onChange={event => draft.set(event.value)}
      onFocus={() => focused.set(true)} onBlur={() => focused.set(false)} />;
  }
  function Transcript() {
    transcriptMounts++;
    const paneWidth = signal(0), project = createNativeHistoryRows();
    const messages: Row[] = [
      { id: 'layout-user', type: 'user', text: 'Synthetic user message' },
      { id: 'layout-assistant', type: 'assistant', content: [{ type: 'text', text: '**Synthetic answer** with no author avatar or extra signature.\n\nNative Markdown remains owned by the production transcript body.' }], finish: 'stop' },
    ];
    const rows = computed(() => { rowComputations++; return project(messages.map(raw => messageFrom(raw)!)); });
    return <List testID="transcript" ref={ref => { transcript = ref; listRefs++; }} class="flex-1 min-h-0" inverted each={rows()} keyExtractor={row => row.key}
      onLayout={event => { if (event.bounds.size.width > 0) paneWidth.set(event.bounds.size.width); }}
      contentStyle={desktopChatListContentStyle} header={() => <View style={{ height: 16 }} />}>
      {row => <NativeChatRow role={row().head.role === 'user' ? 'user' : 'assistant'} header={row().head.role === 'assistant'} wide={wide()} reserveRight={reserve()}>
        <View class="w-full min-w-0" ref={view => { if (row().head.role === 'user') userContent = view; }}>
          <If when={row().head.role === 'assistant'}><NativeTurnHeader message={row().head} modelName="Synthetic model" /></If>
          <NativeTranscriptBody row={row()} target={{ kind: 'session', id: 'layout-session', title: 'Synthetic chat', directory: '/workspace' }} current={() => interactive()}
            contentWidth={platform.desktop ? desktopChatContentWidth(paneWidth(), windowSize().width, wide(), 1, reserve()) : undefined} renderCard={card => <Text>{String(card.id)}</Text>} />
        </View>
      </NativeChatRow>}
    </List>;
  }
  const measure = async () => {
    const [root, surface, input, list, bodyFrame, slot, row] = await Promise.all([main?.measure(), anchor?.measure(), editor?.measure(), transcript?.measure(), body?.measure(), statusProbe?.measure(), userContent?.measure()]);
    result.set(JSON.stringify({ sequence: ++sequence, root, surface, input, list, body: bodyFrame, slot, row, bodyBounds: bodyBounds(), measuredWidth: measuredWidth(), editorMounts, transcriptMounts, rowComputations, bodyRefs, bodyLayouts, bodyMeasures, slotProjections, editorRefs, listRefs }));
  };
  return <View class="flex-1 bg-background">
    <View class="flex-row items-center gap-1" style={{ height: 48 }}>
      <Text class="text-foreground" style={{ width: 260, fontSize: 14 }}>Synthetic desktop titlebar</Text>
      <Button testID="measure" onPress={() => { void measure(); }}><Text>Measure</Text></Button>
      <Button testID="status" onPress={() => status.set(!status())}><Text>Status</Text></Button>
      <Button testID="modal" onPress={() => interactive.set(!interactive())}><Text>Modal</Text></Button>
      <Button testID="panel" onPress={() => panel.set(!panel())}><Text>Panel</Text></Button>
      <Button testID="wide" onPress={() => wide.set(!wide())}><Text>Wide</Text></Button>
      <Button testID="mode" onPress={() => mode.set(mode() === 'history' ? 'empty' : 'history')}><Text>Empty</Text></Button>
    </View>
    <View class="flex-1 min-h-0 flex-row">
      <View style={{ width: 260 }} />
      <View ref={ref => { main = ref; }} class="flex-1 min-h-0 min-w-0">
        <NativeChatBodyLayout
          statusPanel={<If when={slotMode() !== 'hidden'}><StatusSlot /></If>}
          bodyRef={view => { body = view; bodyRefs++; }} onBodyLayout={bodyLayout}
          edgeFade={mode() === 'history'}
          feedback={<If when={status()}><Text testID="warning" class="text-destructive">Synthetic retained read failure</Text></If>}
          transcript={<If when={mode() === 'history'} else={<NativeDesktopChatEmptyState />}><Transcript /></If>}
          historyFeedback={<If when={status()}><Button testID="retry" disabled={!interactive()} onPress={() => calls.set(calls() + 1)}><Text>{t('chat.questionDelegate.retry')}</Text></Button></If>}
          blocking={<If when={status()}><Text testID="blocking" class="text-foreground">Synthetic blocking question</Text></If>}
          composer={<NativeChatComposerLayout state={chrome} compact={<></>} onHeight={() => {}} wide={wide()} reserveRight={reserve()} focused={focused()} anchorRef={ref => { anchor = ref; }} onWidth={width => measuredWidth.set(width)}
            feedback={<If when={status()}><Text testID="draft-feedback" class="text-muted-foreground">Synthetic unsent recovery</Text></If>}
            queue={<If when={status()}><Text testID="queue" class="text-foreground">Synthetic queued follow-up</Text></If>}
            goal={<If when={status()}><Text testID="goal" class="text-foreground">Synthetic active Goal</Text></If>}
            status={<If when={status()}><View class="flex-row justify-between"><Text testID="changes">Synthetic changes</Text><Text testID="tasks">Synthetic tasks</Text></View></If>}
            attachments={<If when={status()}><Text testID="attachments">Synthetic attachment</Text></If>}
            editor={<Editor />}
            leadingActions={<><Button testID="attachment" disabled={!interactive()} style={{ width: 24, height: 24 }} accessibilityLabel={t('chat.chatInput.actions.addAttachment')} onPress={() => calls.set(calls() + 1)}><Icon name="attachment-2" size={18} /></Button>
              <Button testID="dictation" disabled={!interactive()} style={{ width: 24, height: 24 }} accessibilityLabel={t('chat.dictation.start')} onPress={() => calls.set(calls() + 1)}><Icon name="mic" size={18} /></Button></>}
            trailingActions={<><Button testID="selection" disabled={!interactive()} class="min-w-0" style={{ height: 29 }} onPress={() => calls.set(calls() + 1)}><Text style={{ fontSize: 13, numberOfLines: 1 }}>Synthetic model</Text></Button>
              <NativeComposerSend disabled={!interactive() || !draft().trim()} inFlight={false} onPress={() => calls.set(calls() + 1)} /></>}
          />} />
      </View>
      <If when={panel()}><View style={{ width: 400 }} /></If>
    </View>
    <Text testID="result" style={{ fontSize: 1, height: 1, numberOfLines: 1 }}>{`result:${result()}`}</Text>
    <Text testID="calls" style={{ fontSize: 1, height: 1 }}>{`calls:${calls()}`}</Text>
  </View>;
}
mount(Fixture);
