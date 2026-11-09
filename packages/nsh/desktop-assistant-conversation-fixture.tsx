import { host, mount, signal, Text, View, type InputRef, type ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { desktopAssistantEditorStyle, NativeDesktopAssistantComposer, NativeDesktopAssistantEmpty, NativeDesktopAssistantMessage, NativeDesktopAssistantTyping } from './desktop-assistant-conversation';
import { messageFrom, type Row } from './model';
import { language } from './i18n';
import { Icon } from './Icon';

language.set('en');
function Fixture() {
  const draft = signal(''), unrelated = signal(0), interactive = signal(true), mode = signal('messages'), busy = signal(false), feedback = signal(false), focused = signal(false), report = signal('');
  const width = signal(0), height = signal(0), calls = signal(0);
  let editor: InputRef | undefined, surface: ViewRef | undefined, footer: ViewRef | undefined, user: ViewRef | undefined;
  let editorMounts = 0, editorRefs = 0, messageMounts = 0, cardRenders = 0, fileRenders = 0, contentReads = 0, avatarSeedReads = 0, sequence = 0;
  const bot: Row = { id: 'contact-fixture', name: 'Synthetic contact', working: false };
  Object.defineProperty(bot, 'avatarSeed', { get: () => { avatarSeedReads++; return 'contact-fixture'; } });
  const first = messageFrom({ id: 'first', type: 'assistant', parts: [
    { type: 'text', text: '**First** native Markdown [link](https://example.test/)' },
    { type: 'card', cardType: 'session', sessionID: 'session', directory: '/workspace', title: 'Session receipt' },
    { type: 'text', text: 'After session card' },
    { type: 'file', filename: 'source.txt', mime: 'text/plain' },
    { type: 'card', cardType: 'assistant', assistantID: 'new-bot', name: 'Assistant receipt' },
    { type: 'card', cardType: 'schedule', projectID: 'project', taskID: 'task', name: 'Schedule receipt' },
  ] })!;
  const originalContent = first.content;
  Object.defineProperty(first, 'content', { get: () => { contentReads++; return originalContent; } });
  const second = messageFrom({ id: 'second', type: 'assistant', parts: [{ type: 'text', text: 'Same run, no repeated avatar' }] })!;
  const userMessage = messageFrom({ id: 'user', type: 'user', parts: [{ type: 'text', text: '**Literal** user text, not Markdown. A long line that wraps inside the 82 percent and 480 point maximum bubble.' }] })!;
  const peerMessage = messageFrom({ id: 'peer', type: 'peer', parts: [{ type: 'text', text: 'Peer **Markdown**' }] })!;
  const errorMessage = messageFrom({ id: 'error', type: 'assistant', status: 'error', parts: [{ type: 'text', text: 'Synthetic failure' }] })!;
  const legacyMessage = { ...messageFrom({ id: 'legacy', type: 'assistant', text: 'Legacy text' })!, content: undefined };
  function Card(props: { value: Row }) {
    cardRenders++;
    return <View testID={`receipt-${String(props.value.cardType)}`} class="bg-muted" style={{ width: 304, maxWidth: '100%', height: 30 }}><Text>{String(props.value.title || props.value.name)}</Text></View>;
  }
  function Message(props: { source: typeof first; kind: 'assistant' | 'user' | 'peer'; avatar: boolean; separator?: string; spacing?: number }) {
    messageMounts++;
    return <NativeDesktopAssistantMessage message={props.source} bot={bot} kind={props.kind} showAvatar={props.avatar} timeSeparator={props.separator} spacing={props.spacing}
      peerLabel="Peer contact" current={interactive} status={props.kind === 'user' && busy() ? 'sending' : undefined}
      onOpenLink={() => { if (interactive()) calls.set(calls() + 1); }}
      renderCard={card => <Card value={card} />} renderFile={file => { fileRenders++; return <Text testID="rendered-file">{String(file.filename)}</Text>; }} />;
  }
  function Editor() {
    editorMounts++;
    return <Input testID="assistant-editor" ref={ref => { editor = ref; editorRefs++; }} multiline value={draft()} readonly={!interactive()} submitBehavior="submit" accessibilityLabel="Synthetic contact draft" placeholder="Synthetic contact draft"
      class="text-foreground" style={desktopAssistantEditorStyle} onChange={event => draft.set(event.value)} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
      onSubmit={() => { if (interactive() && draft().trim()) calls.set(calls() + 1); }} />;
  }
  host.on<{ action: string; value?: number }>('assistant-layout.control', event => {
    if (event.action === 'unrelated') unrelated.set(event.value || 0);
    else if (event.action === 'snapshot') snapshot();
  });
  function snapshot(frames?: unknown) {
    report.set(JSON.stringify({ sequence: ++sequence, editorMounts, editorRefs, messageMounts, cardRenders, fileRenders, contentReads, avatarSeedReads, width: width(), height: height(), frames }));
  }
  async function measure() { snapshot({ input: await editor?.measure(), surface: await surface?.measure(), footer: await footer?.measure(), user: await user?.measure() }); }
  return <View class="flex-1 bg-background">
    <View class="flex-row" style={{ height: 48 }}>
      <Button testID="measure" onPress={() => { void measure(); }}><Text>Measure</Text></Button>
      <Button testID="modal" onPress={() => interactive.set(!interactive())}><Text>Modal</Text></Button>
      <Button testID="empty" onPress={() => mode.set(mode() === 'empty' ? 'messages' : 'empty')}><Text>Empty</Text></Button>
      <Button testID="peer" onPress={() => mode.set('peer')}><Text>Peer</Text></Button>
      <Button testID="error" onPress={() => mode.set('error')}><Text>Error</Text></Button>
      <Button testID="legacy" onPress={() => mode.set('legacy')}><Text>Legacy</Text></Button>
      <Button testID="busy" onPress={() => busy.set(!busy())}><Text>Busy</Text></Button>
      <Button testID="feedback" onPress={() => feedback.set(!feedback())}><Text>Feedback</Text></Button>
    </View>
    <View class="flex-1 min-h-0 flex-row">
      <View style={{ width: 256, flexShrink: 0 }} />
      <View class="flex-1 min-w-0 min-h-0">
        <View style={{ height: 64, flexShrink: 0 }}><Text>Synthetic existing contact header</Text></View>
        <View class="flex-1 min-h-0 min-w-0" style={{ paddingHorizontal: 32, paddingTop: 28 }}>
          <If when={mode() === 'empty'}><NativeDesktopAssistantEmpty bot={bot} current={interactive} /></If>
          <If when={mode() === 'messages'}><Message source={first} kind="assistant" avatar spacing={0} /><Message source={second} kind="assistant" avatar={false} spacing={6} />
            <View ref={ref => { user = ref; }} class="w-full"><Message source={userMessage} kind="user" avatar={false} spacing={24} /></View>
          </If>
          <If when={mode() === 'peer'}><Message source={peerMessage} kind="peer" avatar separator="Today, 12:30" /></If>
          <If when={mode() === 'error'}><Message source={errorMessage} kind="assistant" avatar /></If>
          <If when={mode() === 'legacy'}><Message source={legacyMessage} kind="assistant" avatar /></If>
          <If when={busy()}><NativeDesktopAssistantTyping bot={bot} current={interactive} /></If>
        </View>
        <View ref={ref => { footer = ref; }} class="shrink-0">
          <NativeDesktopAssistantComposer editor={<Editor />} anchorRef={ref => { surface = ref; }} focused={focused()} onWidth={value => width.set(value)} onHeight={value => height.set(value)}
            attach={<Button testID="attach" class="size-8 items-center justify-center bg-transparent rounded-md hover:bg-accent focus:bg-accent" disabled={!interactive()} accessibilityLabel="Synthetic unsupported attachment" onPress={() => feedback.set(true)}><Icon name="attachment-2" size={18} /></Button>}
            send={<Button testID="send" class="size-8 items-center justify-center bg-secondary rounded-full hover:bg-accent focus:bg-accent" disabled={!interactive() || !draft().trim()} accessibilityLabel="Synthetic send" onPress={() => { if (interactive()) calls.set(calls() + 1); }}><Icon name="arrow-up" size={18} /></Button>}
            attachments={<If when={feedback()}><Text testID="attachment-placeholder">Attachment upload unavailable</Text></If>}
            feedback={<If when={feedback()}><Text testID="feedback-slot">Synthetic retained failure</Text></If>}
            overlays={<View testID="overlay-slot" style={{ position: 'absolute', width: 1, height: 1, top: -1 }} />} />
        </View>
      </View>
    </View>
    <Text style={{ height: 1, fontSize: 1 }}>{`unrelated:${unrelated()}`}</Text>
    <Text testID="calls" style={{ height: 1, fontSize: 1 }}>{`calls:${calls()}`}</Text>
    <Text testID="report" style={{ height: 1, fontSize: 1 }}>{`report:${report()}`}</Text>
  </View>;
}
mount(Fixture);
