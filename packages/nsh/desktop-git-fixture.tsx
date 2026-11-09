import { computed, host, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { bindRawRequest } from './runtime';
import { NativeDesktopGit } from './desktop-git';
import type { DesktopPanelScope } from './desktop-panel-model';
import { desktopGitWorktreeState } from './desktop-git-worktree-state';

function Fixture() {
  language.set('en');
  const selected = signal('synthetic-a'), active = signal(true), stats = signal('{}'), opened = signal(''), agent = signal(''), canonicalReady = signal(false);
  const scope = computed<DesktopPanelScope>(() => ({ host: { hostID: selected(), lease: selected() + '-lease' }, authorityKey: selected() + '-authority', sessionID: 'session', directory: '/synthetic/worktree' }));
  host.on('desktop-git.stats', value => stats.set(JSON.stringify(value)));
  const control = (mode: string) => { void bindRawRequest(scope().host)('/fixture/control?mode=' + mode); };
  return <View class="flex-1">
    <View class="flex-row flex-wrap">
      <Button testID="fixture-git-switch" onPress={() => selected.set(selected() === 'synthetic-a' ? 'synthetic-b' : 'synthetic-a')}><Text>Switch synthetic Host</Text></Button>
      <Button testID="fixture-git-hide" onPress={() => active.set(!active())}><Text>Visibility</Text></Button>
      <Button testID="fixture-git-fail-status" onPress={() => control('status')}><Text>Fail status</Text></Button>
      <Button testID="fixture-git-fail-write" onPress={() => control('write')}><Text>Lose write response</Text></Button>
      <Button testID="fixture-git-merge" onPress={() => control('merge')}><Text>Synthetic merge</Text></Button>
      <Button testID="fixture-git-pr-new" onPress={() => control('pr-new')}><Text>Synthetic new PR</Text></Button>
      <Button testID="fixture-git-generation-fallback" onPress={() => control('generation-fallback')}><Text>Synthetic generation fallback</Text></Button>
      <Button testID="fixture-git-canonical-ready" onPress={() => canonicalReady.set(true)}><Text>Synthetic canonical ready</Text></Button>
    </View>
    <Text style={{ numberOfLines: 1, maxHeight: 20 }}>{'git-stats:' + stats()}</Text><Text style={{ numberOfLines: 1, maxHeight: 20 }}>{'git-opened:' + opened()}</Text><Text style={{ numberOfLines: 1, maxHeight: 20 }}>{'git-agent:' + agent()}</Text>
    <Each of={[scope()]} key={value => value.host.hostID}>{captured => <NativeDesktopGit scope={captured()} current={() => captured().host.hostID === selected()} active={active()} onOpenDiff={source => opened.set(JSON.stringify(source))} onOpenFile={path => opened.set(path)} worktreeAttachment={canonicalReady() ? desktopGitWorktreeState(captured(), { value: { worktreeRoot: '/synthetic/canonical-container', cwd: captured().directory, branch: 'synthetic-b-feature', headState: 'branch', worktreeStatus: 'ready', legacy: false, degraded: false, attentionReason: null } }) : undefined} onResolveWithAgent={request => { agent.set(JSON.stringify({ target: request.target, kind: request.kind, directory: request.directory, host: request.scope.host.hostID, visible: request.visibleText })); }} />}</Each>
  </View>;
}
mount(Fixture);
