/** Synthetic content only: production body handlers, no Host/network/writer. */
import { computed, mount, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeTranscriptBody } from './transcript-body';
import { nativeBodyRows } from './transcript-body-model';
import { messageFrom } from './model';
import { appearanceFromSettings } from './appearance-core';
import { nativeAppearance, nativeCodeFontSize } from './appearance';
import { language } from './i18n';

function Fixture() {
  language.set('en');
  const kind = signal('assistant'), fold = signal(false), current = signal(true), last = signal(''), count = signal(0), ready = signal(false);
  const row = computed(() => nativeBodyRows([messageFrom({ id: 'message', type: kind() === 'user' ? 'user' : 'assistant', finish: 'stop', content: [{ id: 'part', type: kind() === 'reasoning' ? 'reasoning' : 'text', text: '[Open](README.md#L12) [Fail](#heading)' }] })!])[0]!);
  async function appearance() {
    const value = await appearanceFromSettings({ chatRenderMode: 'live', collapsibleThinkingBlocks: fold() }, async () => []);
    nativeCodeFontSize.set(100);
    nativeAppearance.current.set({ ...value, uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [], sourceHost: { hostID: 'synthetic', generation: 1, url: 'https://synthetic.invalid' } });
    ready.set(true);
  }
  void appearance();
  return <View class="flex-1">
    <View class="flex-row">
      <Button testID="user" onPress={() => kind.set('user')}><Text>User</Text></Button>
      <Button testID="assistant" onPress={() => kind.set('assistant')}><Text>Assistant</Text></Button>
      <Button testID="reasoning" onPress={() => kind.set('reasoning')}><Text>Reasoning</Text></Button>
      <Button testID="fold" onPress={() => { fold.set(!fold()); void appearance(); }}><Text>Fold</Text></Button>
      <Button testID="inactive" onPress={() => current.set(false)}><Text>Inactive</Text></Button>
    </View>
    <Text>{`CALLS:${count()}`}</Text><Text>{`LAST:${last()}`}</Text>
    <If when={ready()}><Scroll class="flex-1"><NativeTranscriptBody row={row()} target={{ kind: 'session', id: 'own-session', directory: '/repo/own', title: 'Synthetic' }} current={current}
      onOpenLink={async href => { count.set(count() + 1); if (href.startsWith('#')) throw new Error('content_link_anchor_unavailable'); last.set(href); }} renderCard={() => <Text>Card</Text>} /></Scroll></If>
  </View>;
}
mount(Fixture);
