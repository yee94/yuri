import { host, mount, signal, Text, View } from 'nsh';
import { Button, type DiffViewRef } from 'nsh/base';
import { nativeAppearance, nativeCodeFontSize } from './appearance';
import { appearanceFromSettings, type AppliedNativeAppearance } from './appearance-core';
import { DesktopGitDiff } from './desktop-git-diff';
import { NativeDesktopGit } from './desktop-git';
import { language } from './i18n';
import type { DesktopPanelScope } from './desktop-panel-model';

// Headless only: no appearance sync, Storage, real Host, or native window.
function Fixture() {
  language.set('en');
  const active = signal(true), ready = signal(false), stats = signal('{}'), inspected = signal('{}');
  const before = signal('PROBE_OLD_ONE\nPROBE_OLD_TWO\nPROBE_OLD_THREE\n');
  const after = signal('PROBE_NEW_ONE\nPROBE_NEW_TWO\nPROBE_NEW_THREE\n');
  let diff: DiffViewRef | undefined, mounts = 0, appearance: AppliedNativeAppearance;
  const scope: DesktopPanelScope = { host: { hostID: 'synthetic-b', lease: 'synthetic-b-lease' }, authorityKey: 'synthetic-typography', sessionID: 'session', directory: '/synthetic/worktree' };
  host.on('desktop-git.stats', value => stats.set(JSON.stringify(value)));
  void appearanceFromSettings({ fontSize: 125, monoFont: 'system-mono' }, async () => { throw new Error('Unexpected theme catalog'); }).then(value => {
    appearance = { ...value, uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [] };
    nativeAppearance.current.set(appearance); nativeCodeFontSize.set(100); ready.set(true);
  });
  async function inspect() {
    if (!diff) return;
    inspected.set(JSON.stringify({ mounts, range: await diff.selectedLines(), text: await diff.selectedText(), bounds: await diff.hunkBounds(), before: before(), after: after(), stats: await diff.stats() }));
  }
  return <View class="flex-1">
    <View class="flex-row flex-wrap gap-2">
      <Button testID="typography-scale-100" onPress={() => nativeCodeFontSize.set(100)}><Text>Code 100</Text></Button>
      <Button testID="typography-scale-150" onPress={() => nativeCodeFontSize.set(150)}><Text>Code 150</Text></Button>
      <Button testID="typography-family" onPress={() => nativeAppearance.current.set({ ...appearance, monoFontFamily: 'JetBrains Mono' })}><Text>Code family</Text></Button>
      <Button testID="typography-hide" onPress={() => active.set(!active())}><Text>Visibility</Text></Button>
      <Button testID="typography-select" onPress={async () => { await diff?.setSelectedLines({ side: 'new', start: 0, end: 1 }); await inspect(); }}><Text>Select probe lines</Text></Button>
      <Button testID="typography-inspect" onPress={() => { void inspect(); }}><Text>Inspect probe</Text></Button>
    </View>
    <Text style={{ numberOfLines: 1 }}>{'typography-ready:' + ready()}</Text><Text style={{ numberOfLines: 1 }}>{'typography-stats:' + stats()}</Text><Text style={{ numberOfLines: 1 }}>{'typography-probe:' + inspected()}</Text>
    <If when={ready()}><View class="flex-1 flex-row">
      <View class="flex-1"><NativeDesktopGit scope={scope} current={() => true} active={active()} onOpenDiff={() => {}} onOpenFile={() => {}} /></View>
      <View style={{ width: 350 }}><DesktopGitDiff testID="typography-probe-diff" class="flex-1" oldValue={before()} newValue={after()} layout="unified" lineNumbers ref={value => { diff = value; mounts++; }} /></View>
    </View></If>
  </View>;
}
mount(Fixture);
