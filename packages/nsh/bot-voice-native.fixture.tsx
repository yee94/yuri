import { mount, Scroll, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { BotEditor } from './features';
import { SettingsVoiceModels } from './settings-voice-models';
import { language } from './i18n';
import { app } from './state';

/** Isolated production-component entrypoint. Only the supplied fake Host is allowed. */
function BotVoiceFixture() {
  language.set('en');
  app.connection.set({ id: 'fixture', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 });
  const selected = signal('parakeet-tdt-0.6b-v2-int8'), voice = signal(0), active = signal(true), finished = signal(false);
  const nav = createNavStack<'root' | 'bot' | 'voice'>(['root']);
  return <NavStack state={nav}>{route => {
    if (route === 'bot') return <BotEditor defaultContext={{ directory: '/workspace/actual', selection: { providerID: 'current', modelID: 'selected', variant: 'medium' } }} onDone={() => { finished.set(true); nav.pop(); }} />;
    if (route === 'voice') return <NavPage title="Voice fixture" headerBackTitle=""><Scroll class="flex-1" contentClass="gap-3 p-4"><Button testID="fixture-toggle-active" onPress={() => active.set(!active())}><Text>Toggle active</Text></Button><Text testID="fixture-local-selection">{selected()}</Text><SettingsVoiceModels stt tts selectedModel={selected()} voice={voice()} onSelect={value => selected.set(value)} onVoice={value => voice.set(value)} current={() => true} active={active() && nav.routes().at(-1) === route} disabled={false} /></Scroll></NavPage>;
    return <NavPage title="Bot and Voice fixture" headerBackTitle=""><View><Button testID="fixture-open-bot" onPress={() => nav.push('bot')}><Text>Bot</Text></Button><Button testID="fixture-open-voice" onPress={() => nav.push('voice')}><Text>Voice</Text></Button><If when={finished()}><Text testID="fixture-bot-saved">Saved</Text></If></View></NavPage>;
  }}</NavStack>;
}
mount(BotVoiceFixture);
