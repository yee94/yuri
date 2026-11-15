/** Synthetic artwork/content carrier; mounts production NSH components without a Host. */
import { colorScheme, computed, mount, Scroll, setColorScheme, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { AssistantWallpaper, AssistantIdentity } from './assistants-workspace';
import { AssistantSwipeRow } from './assistants-swipe';
import { AssistantAvatar } from './assistants-avatar-live';
import { NativeTranscriptBody } from './transcript-body';
import { nativeBodyRows } from './transcript-body-model';
import { messageFrom } from './model';
import { language } from './i18n';

language.set('zh-CN');
const bot = { id: 'artwork-fixture', name: 'Magpie 助理', avatarSeed: 'yuri-avatar:v1:round:capsule:cyan:neutral:1:fixture' };
const pinnedBot = { ...bot, id: 'pinned-artwork-fixture', name: '大小白' };
function Fixture() {
  setColorScheme('light');
  const chat = signal(false), edited = signal(false), suffix = signal(''), revealed = signal<string | null>(null);
  const rows = computed(() => nativeBodyRows([
    messageFrom({ id: 'question', type: 'user', createdAt: 1800000000000, text: '帮我整理一下今天的进展。' })!,
    messageFrom({ id: 'answer', type: 'assistant', createdAt: 1800000060000, text: '已经整理好了。\n\n1. **项目进展**：核心功能已完成。\n2. **下一步**：验证手机上的布局和交互。' + suffix() })!,
  ]));
  return <View class="flex-1 bg-background">
    <AssistantWallpaper />
    <View class="flex-row px-4 pt-12 gap-3">
      <Button testID="workspace-mode" class="min-h-11 px-3 bg-secondary rounded-xl" onPress={() => chat.set(!chat())}><Text class="text-foreground">{chat() ? 'Catalog' : 'Conversation'}</Text></Button>
      <Button testID="workspace-theme" class="min-h-11 px-3 bg-secondary rounded-xl" onPress={() => setColorScheme(colorScheme() === 'dark' ? 'light' : 'dark')}><Text class="text-foreground">Theme</Text></Button>
      <Button testID="workspace-replace" class="min-h-11 px-3 bg-secondary rounded-xl" onPress={() => suffix.set('\n\n内容已更新，原文保留。')}><Text class="text-foreground">Replace</Text></Button>
    </View>
    <If when={chat()} else={<View class="p-5 gap-3">
      <Text class="text-3xl font-bold text-foreground">Bots</Text>
      <AssistantSwipeRow binding={pinnedBot} generation={0} id={pinnedBot.id} name={pinnedBot.name} pinned disabled={false} revealed={null} onReveal={() => {}} onOpen={() => chat.set(true)} onEdit={() => edited.set(true)} onDelete={() => {}} onMenu={() => edited.set(true)}>
        <AssistantAvatar bot={pinnedBot} size={64} active={false} /><View style={{ width: 96, minWidth: 0, maxWidth: 96 }}><Text class="text-foreground text-center" style={{ numberOfLines: 1, textOverflow: 'ellipsis' }}>{pinnedBot.name}</Text></View>
      </AssistantSwipeRow>
      <AssistantSwipeRow binding={bot} generation={0} id={bot.id} name={bot.name} pinned={false} disabled={false} revealed={revealed()} onReveal={id => revealed.set(id)} onOpen={() => chat.set(true)} onEdit={() => edited.set(true)} onDelete={() => {}} onMenu={() => edited.set(true)}>
        <AssistantAvatar bot={bot} active={false} /><View class="flex-1 gap-1"><Text class="font-semibold text-foreground">{bot.name}</Text><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>换个新头像，好了。看看合不合眼缘，不满意我再换。</Text></View>
      </AssistantSwipeRow>
    </View>}>
      <View class="py-4"><AssistantIdentity bot={bot} active={false} onPress={() => edited.set(true)} /></View>
      <Scroll class="flex-1" contentClass="px-6 gap-4 py-4"><Each of={rows()}>{row => <NativeTranscriptBody row={row()} contactBot={bot} target={{ kind: 'assistant', id: bot.id, title: bot.name, directory: '/workspace' }} current={() => true} renderCard={() => null} />}</Each></Scroll>
    </If>
    <If when={edited()}><Text testID="workspace-edited">Settings opened</Text></If>
  </View>;
}
mount(Fixture);
