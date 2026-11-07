import { cleanup, mount, signal, List, Text, View, safeArea, type InputRef, type ListRef } from 'nsh';
import { Button, createNavStack, Input, NavPage, NavStack } from 'nsh/base';
import { createChatChromeState, createNativeChatChrome } from './chat-chrome';
import { NativeComposerChrome } from './chat-chrome-surfaces';
import { NativeChatHeaderCollapse } from './chat-chrome-native';
import { NativeSheet } from './native-sheet';
import { NativeSelect } from './native-select';
import { NativeDatePicker } from './native-date-picker';
import { NativeNewSessionModal } from './new-session-modal';

/** Isolated UIKit carrier for production presentation/chrome; no Host or model calls. */
function Fixture() {
  const nav = createNavStack(['chat']);
  return <NavStack state={nav} class="flex-1">{() => <Page />}</NavStack>;
}
function Page() {
  const state = signal(createChatChromeState()), height = signal(160), draft = signal('Retained draft'), sheet = signal(false), guarded = signal(false), newSession = signal<'model' | null>(null);
  const selected = signal('0'), date = signal('2026-11-07'), rows = signal(Array.from({ length: 500 }, (_, index) => ({ id: `${index}`, title: `Reading row ${500 - index}: native history text.\n${'Content with a stable reading anchor. '.repeat(index % 3 + 1)}` })));
  const chrome = createNativeChatChrome(value => state.set(value));
  let input: InputRef | undefined, list: ListRef | undefined;
  cleanup(chrome.dispose);
  return <NavPage title="Native chrome QA" headerTransparent class="flex-1 bg-background" headerRight={<Button testID="qa-sheet" class="min-h-11 px-2" onPress={() => sheet.set(true)}><Text class="text-foreground">Sheet</Text></Button>}>
    <NativeChatHeaderCollapse active progress={state().swap.progress} duration={state().swap.phase === 'snapping' ? 240 : 0} style={{ position: 'absolute', width: 0, height: 0 }} />
    <List testID="qa-history" class="flex-1" inverted each={rows()} keyExtractor={row => row.id} ref={node => { list = node; }} contentStyle={{ paddingHorizontal: 16, paddingTop: 80, gap: 24 }} header={() => <View style={{ height: height() + 16 }} />}
      onScrollDragStart={chrome.begin} onScroll={chrome.scroll} onScrollDragEnd={chrome.release} onScrollEnd={chrome.end} onMomentumEnd={chrome.end} keyboardDismissMode="interactive">
      {row => <Text testID={`qa-row-${row().id}`} class="text-foreground" style={{ fontSize: 16, lineHeight: 24 }}>{row().title}</Text>}
    </List>
    <NativeComposerChrome state={state()} bottom={safeArea().bottom + 16} onHeight={value => height.set(value)} compact={<>
      <Button testID="qa-compact-edit" class="flex-1 min-h-11 justify-center" onPress={() => { chrome.expand(); input?.focus(); }}><Text class="text-foreground" style={{ numberOfLines: 1 }}>{draft()}</Text></Button>
      <Button testID="qa-latest" class="size-8 items-center justify-center" onPress={() => { chrome.expand(); list?.scrollToIndex({ index: 0, viewPosition: 1, animated: true }); }}><Text>↓</Text></Button>
    </>}>
      <View class="px-3 pt-2" style={{ paddingBottom: safeArea().bottom + 16 }}>
        <View class="bg-card rounded-3xl p-3 gap-2"><Input testID="qa-editor" ref={node => { input = node; }} multiline value={draft()} onChange={event => draft.set(event.value)} onFocus={() => chrome.pin(true)} onBlur={() => chrome.pin(false)} class="text-foreground min-h-14" />
          <View class="flex-row gap-2"><Button testID="qa-new-session" class="min-h-11 px-3" onPress={() => newSession.set('model')}><Text>New picker</Text></Button>
            <NativeSelect accessibilityLabel="Choose item" searchable value={selected()} items={Array.from({ length: 300 }, (_, index) => ({ value: `${index}`, title: `Choice ${index}` }))} onChange={event => selected.set(event.value ?? '')} trigger={<Text class="text-foreground">Select {selected()}</Text>} />
            <NativeDatePicker value={date()} onChange={event => { if (typeof event.value === 'string') date.set(event.value); }} trigger={<Text class="text-foreground">{date()}</Text>} accessibilityLabel="Choose date" />
          </View>
        </View>
      </View>
    </NativeComposerChrome>
    <NativeSheet testID="qa-system-sheet" open={sheet()} detents={[.42, .72, 1]} closeOnSwipe={!guarded()} closeOnBackdropPress={!guarded()} closeOnEscape={!guarded()} onOpenChange={event => sheet.set(event.open)} popupClass="bg-background p-4 gap-3">
      <Text class="text-foreground">System Sheet QA</Text>
      <Button testID="qa-guard" class="min-h-11" onPress={() => guarded.set(!guarded())}><Text class="text-foreground">{guarded() ? 'Unlock dismissal' : 'Lock dismissal'}</Text></Button>
      <Button testID="qa-close" class="min-h-11" onPress={() => sheet.set(false)}><Text class="text-foreground">Close</Text></Button>
      <List class="flex-1" each={Array.from({ length: 100 }, (_, index) => index)} keyExtractor={index => `${index}`}>{index => <Text class="text-foreground p-4">Sheet row {index()}</Text>}</List>
    </NativeSheet>
    <NativeNewSessionModal value={newSession()} active={() => true} onClose={() => newSession.set(null)} height={600}>
      {(_value, _active, close) => <View class="flex-1 p-4 gap-4"><Text class="text-foreground">Production new-session modal</Text><Button testID="qa-new-close" class="min-h-11" onPress={close}><Text>Close picker</Text></Button></View>}
    </NativeNewSessionModal>
  </NavPage>;
}
mount(Fixture);
