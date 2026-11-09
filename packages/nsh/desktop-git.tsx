import { cleanup, Clipboard, computed, effect, host, lifecycle, List, signal, Text, token, untracked, View } from 'nsh';
import { AlertDialog, Button, Input } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { bindRawRequest } from './runtime';
import { runtimeEventFrom } from './model';
import { type ChangesSource, type HistoricalChange } from './chat-changes-model';
import { createDesktopGit, type DesktopGitFile, type DesktopGitAction } from './desktop-git-model';
import type { DesktopPanelScope } from './desktop-panel-model';
import { desktopGitGraph, NativeDesktopGitGraphSegment } from './desktop-git-graph';
import { DesktopGitChanges } from './desktop-git-changes';
import { DesktopGitIdentity, DesktopGitPullRequest, DesktopGitWorktree, type DesktopGitCallbacks } from './desktop-git-extra';
import { desktopGitmojis, insertDesktopGitmoji, type DesktopGitmoji } from './desktop-git-gitmoji';
import { DesktopGitDiff } from './desktop-git-diff';

const action = 'min-h-8 px-2 rounded-md bg-secondary hover:bg-accent active:bg-accent disabled:opacity-40 flex-row items-center justify-center gap-1.5';
const quiet = 'min-h-8 px-2 rounded-md hover:bg-accent active:bg-accent disabled:opacity-40 flex-row items-center gap-1.5';
const input = 'min-h-8 px-2 rounded-md bg-secondary text-sm text-foreground';
type Section = 'changes' | 'branches' | 'stashes' | 'history' | 'graph' | 'identity' | 'pr' | 'worktree';
const sections: { id: Section; key: I18nKey }[] = [
  { id: 'changes', key: 'gitView.changes.title' }, { id: 'branches', key: 'gitView.branch.selectBranch' },
  { id: 'stashes', key: 'gitView.stashes.title' }, { id: 'history', key: 'gitView.history.title' }, { id: 'graph', key: 'gitView.graph.title' },
  { id: 'identity', key: 'gitView.header.identityTooltip' }, { id: 'pr', key: 'gitView.tabs.pr' }, { id: 'worktree', key: 'gitView.tabs.worktree' },
];

export type NativeDesktopGitProps = DesktopGitCallbacks & {
  scope: DesktopPanelScope; current: () => boolean; active: boolean;
  onOpenDiff: (source: ChangesSource) => void; onOpenFile: (path: string, line?: number) => void;
  gitmojis?: readonly DesktopGitmoji[];
};

/** Native Git rail; the parent owns scope and file/diff tabs, never this owner. */
export function NativeDesktopGit(props: NativeDesktopGitProps) {
  const revision = signal(0), section = signal<Section>('changes'), message = signal(''), branch = signal(''), search = signal(''), remote = signal(''), stashMessage = signal('');
  const logCount = signal(25), selectedCommit = signal(''), files = signal<DesktopGitFile[]>([]), fileLoading = signal(false), fileError = signal(''), diff = signal<HistoricalChange | null>(null);
  const localError = signal('');
  const gitmojiOpen = signal(false), gitmojiSearch = signal(''), highlights = signal<string[]>([]);
  let alive = true, fileGeneration = 0;
  const active = computed(() => alive && props.current() && props.active && lifecycle() === 'active');
  const git = createDesktopGit(props.scope, bindRawRequest(props.scope.host), active, () => untracked(() => revision.set(revision() + 1)), () => props.worktreeAttachment);
  const resource = <K extends Parameters<typeof git.resource>[0]>(key: K) => { revision(); return git.resource(key); };
  const status = () => resource('status').value;
  const pending = () => { revision(); return git.pending(); };
  const unknown = () => { revision(); return git.unknown(); };
  const writeUnknown = () => { revision(); return git.writeUnknown(); };
  const generationUnknown = () => { revision(); return git.generationUnknown(); };
  const canReview = () => { revision(); return git.canAcknowledgeUnknown(); };
  const disabled = () => !active() || pending() || !!writeUnknown() || (revision(), !!git.blockingReason('stage'));
  const staged = computed(() => status()?.files.filter(file => !!file.index.trim() && !['?', '!'].includes(file.index.trim())) ?? []);
  const errorText = (error: string) => /^(gitView|diffView)\./.test(error) ? t(error as I18nKey) : error;
  const mutationError = () => { revision(); return localError() || errorText(git.mutationError()); };
  const graph = computed(() => section() === 'graph' ? desktopGitGraph(resource('log').value?.all ?? []) : { rows: [], width: 0 });
  async function run(mutation: DesktopGitAction) {
    if (mutation.kind === 'worktreeInspect' ? !active() || pending() || !!git.writeUnknown() : disabled()) return false;
    localError.set('');
    return await git.mutate(mutation);
  }
  async function confirm(title: string, description: string, mutation: DesktopGitAction) {
    if (disabled()) return;
    const answer = await AlertDialog.show({ title, description, actions: [
      { id: 'confirm', label: t('gitView.history.actions.confirmButton'), role: 'destructive' },
      { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
    ] });
    if (active() && answer.action === 'confirm') await run(mutation);
  }
  async function commit(andPush: boolean) {
    const submitted = message();
    if (!submitted.trim()) { localError.set(t('gitView.toast.enterCommitMessage')); return; }
    if (await run({ kind: 'commit', message: submitted })) {
      if (active() && message() === submitted) message.set('');
      // A confirmed commit is never repeated if the separately admitted push fails.
      if (andPush && active()) await run({ kind: 'push', remote: remote() || undefined });
    }
  }
  async function generateCommit() {
    const before = message();
    if (await git.generate('commit')) {
      const value = git.resource('generated').value;
      if (active() && value?.purpose === 'commit' && message() === before) { message.set(value.subject); highlights.set(value.highlights); }
    }
  }
  async function resolveWithAgent(target: 'current' | 'new') {
    if (!active() || !props.onResolveWithAgent || target === 'current' && !git.scope.sessionID) return;
    try {
      if (!await git.refreshConflicts() || !active()) return;
      const details = git.resource('conflicts').value;
      if (!details) return;
      const operation = status()?.operation || details.operation;
      const text = await git.agentPrompt('git.conflict.resolve', { operation, operation_label: operation, directory: git.scope.directory, head_info: details.headInfo, head_ref: details.headInfo, continue_cmd: `git ${operation} --continue` });
      if (active()) await props.onResolveWithAgent({ scope: git.scope, directory: git.scope.directory, target, kind: 'conflict', ...text, payload: details });
    } catch (cause) { if (active()) localError.set(String(cause)); }
  }
  function refreshSection() {
    if (!active()) return;
    const target = section();
    if (target === 'stashes') void git.refreshStashes();
    if (target === 'history' || target === 'graph') void git.refreshLog(logCount(), target === 'graph');
  }
  effect(() => {
    if (!active()) { untracked(() => { fileGeneration++; git.cancel(); }); return; }
    untracked(() => { if (!resource('status').error) void git.refresh(); });
  });
  effect(() => { section(); if (active()) untracked(refreshSection); });
  effect(() => {
    if (!active()) return;
    const refresh = () => {
      if (!active() || pending() || resource('status').loading || resource('status').error) return;
      void git.refreshStatus();
    };
    const timer = setInterval(refresh, 10_000);
    const stop = host.on('runtime.event', payload => {
      const event = runtimeEventFrom(payload);
      if (event?.key === 'global' && (!event.directory || event.directory === git.scope.directory) && (event.type === 'reconnected' || /^(vcs\.|yuri:git-|yuri:workspace-)/.test(event.type))) refresh();
    });
    cleanup(() => { clearInterval(timer); stop(); });
  });
  cleanup(() => { alive = false; fileGeneration++; git.dispose(); });
  async function selectCommit(hash: string) {
    if (!active()) return;
    const serial = ++fileGeneration;
    if (selectedCommit() !== hash) files.set([]);
    selectedCommit.set(hash); diff.set(null); fileLoading.set(true); fileError.set('');
    try { const next = await git.commitFiles(hash); if (active() && serial === fileGeneration) files.set(next); }
    catch (cause) { if (active() && serial === fileGeneration) fileError.set(String(cause)); }
    finally { if (active() && serial === fileGeneration) fileLoading.set(false); }
  }
  async function selectDiff(file: DesktopGitFile) {
    if (!active()) return;
    if (file.changeType === 'R') { fileError.set(t('gitView.history.renamedNoDiff')); return; }
    const hash = selectedCommit(), serial = ++fileGeneration;
    fileLoading.set(true); fileError.set('');
    try { const next = await git.commitDiff(hash, file); if (active() && serial === fileGeneration && hash === selectedCommit()) diff.set(next); }
    catch (cause) { if (active() && serial === fileGeneration) fileError.set(String(cause)); }
    finally { if (active() && serial === fileGeneration) fileLoading.set(false); }
  }
  return <View testID="desktop-git" class="flex-1 bg-background">
    <View class="p-2 gap-2 border-b border-border/30">
      <View class="flex-row items-center gap-2">
        <Icon name="git-branch" size={15} /><Text class="flex-1 text-sm text-foreground" style={{ numberOfLines: 1 }}>{status() ? status()?.current || t('gitView.branch.detachedHead') : t('gitView.branch.currentBranchFallback')}</Text>
        <Text class="text-xs text-muted-foreground">{status() ? `${status()!.behind ?? 0}↓ ${status()!.ahead ?? 0}↑` : ''}</Text>
        <Button testID="desktop-git-refresh" class={quiet} disabled={!active() || pending()} accessibilityLabel={t('mobile.files.refreshAria')} onPress={() => { void git.refresh(); refreshSection(); }}><Icon name="refresh" size={14} /></Button>
      </View>
      <If when={!!status()?.tracking}><Text class="text-xs text-muted-foreground">{status()?.tracking}</Text></If>
      <View class="flex-row flex-wrap gap-1">
        <Each of={['pull', 'push', 'fetch'] as const}>{kind => <Button testID={`desktop-git-${kind()}`} class={action} disabled={disabled()} onPress={() => { void run({ kind: kind(), remote: remote() || undefined }); }}><Text class="text-xs text-foreground">{t(`gitView.sync.${kind()}`)}</Text></Button>}</Each>
        <Each of={resource('remotes').value ?? []} key={item => item.name}>{item => <Button testID={`desktop-git-remote-${item().name}`} class={quiet} selected={remote() === item().name} onPress={() => { if (active()) remote.set(remote() === item().name ? '' : item().name); }}><Text class="text-xs text-foreground">{item().name}</Text></Button>}</Each>
      </View>
      <If when={pending()}><Text class="text-xs text-muted-foreground">{t('gitView.common.processing')}</Text></If>
      <If when={!!unknown()}><View class="gap-1"><Text role="alert" class="text-xs" style={{ color: token('destructive') }}>{t('chat.questionDelegate.uncertain')}</Text><Button testID="desktop-git-review-unknown" class={action} disabled={!canReview()} onPress={() => { git.acknowledgeUnknown(); }}><Text class="text-xs text-foreground">{t('gitView.common.done')}</Text></Button></View></If>
      <If when={!!mutationError()}><Text testID="desktop-git-mutation-error" role="alert" class="text-xs text-destructive">{mutationError()}</Text></If>
      <Each of={['repository', 'status', 'branches', 'remotes'] as const}>{key => <If when={!!resource(key()).error}><Text role="alert" class="text-xs text-destructive">{resource(key()).error}</Text></If>}</Each>
      <If when={(revision(), git.repositoryState() === 'not-a-repo')}><Text class="text-sm text-muted-foreground">{t('gitView.empty.notGitRepository')}</Text></If>
      <If when={(revision(), git.repositoryState() === 'pending')}><Text class="text-sm text-muted-foreground">{t('gitView.empty.worktreeSetupInProgress')}</Text></If>
      <If when={resource('status').loading}><Text class="text-xs text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!!status()?.operation}><View class="gap-1">
        <Text class="text-sm" style={{ color: token('foreground') }}>{t('gitView.operation.inProgressTitle', { operation: t(status()?.operation === 'merge' ? 'gitView.operation.merge' : 'gitView.operation.rebase') })}</Text>
        <Text class="text-xs text-muted-foreground">{status()?.operationDetail}</Text>
        <Text class="text-xs text-muted-foreground">{t('gitView.operation.resolveConflictsHint')}</Text>
        <View class="flex-row gap-1"><Button testID="desktop-git-continue" class={action} disabled={disabled() || !!status()?.conflicted.length} onPress={() => { void run({ kind: status()?.operation === 'merge' ? 'mergeContinue' : 'rebaseContinue' }); }}><Text class="text-xs text-foreground">{t('gitView.operation.continue')}</Text></Button><Button testID="desktop-git-abort" class={action} disabled={disabled()} onPress={() => { void confirm(t('gitView.operation.abort'), status()?.operationDetail ?? '', { kind: status()?.operation === 'merge' ? 'mergeAbort' : 'rebaseAbort', confirmed: true }); }}><Text class="text-xs text-destructive">{t('gitView.operation.abort')}</Text></Button><Button testID="desktop-git-conflicts" class={action} onPress={() => { void git.refreshConflicts(); }}><Text class="text-xs text-foreground">{t('gitView.conflict.conflictedFiles')}</Text></Button></View>
      </View></If>
      <Each of={status()?.conflicted ?? []} key={path => path}>{path => <Button class={quiet} onPress={() => { if (active()) props.onOpenFile(path()); }}><Text class="text-xs" style={{ color: token('destructive') }}>{path()}</Text></Button>}</Each>
      <If when={!!resource('conflicts').error}><Text role="alert" class="text-xs text-destructive">{resource('conflicts').error}</Text></If>
      <If when={!!resource('conflicts').value}><Text class="text-xs text-muted-foreground">{resource('conflicts').value?.headInfo}</Text></If>
      <If when={!!props.onResolveWithAgent && (!!status()?.operation || !!status()?.conflicted.length)}><View class="flex-row flex-wrap gap-1"><Each of={['current', 'new'] as const}>{target => <Button testID={`desktop-git-resolve-${target()}`} class={action} disabled={!active() || target() === 'current' && !git.scope.sessionID} onPress={() => { void resolveWithAgent(target()); }}><Text class="text-xs text-foreground">{t(target() === 'current' ? 'gitView.conflict.resolveCurrentSession' : 'gitView.conflict.resolveNewSession')}</Text></Button>}</Each></View></If>
      <View class="flex-row flex-wrap gap-1"><Each of={sections} key={item => item.id}>{item => <Button testID={`desktop-git-tab-${item().id}`} class={quiet} selected={section() === item().id} onPress={() => { if (active()) { section.set(item().id); search.set(''); } }}><Text class="text-xs text-foreground">{t(item().key)}</Text></Button>}</Each></View>
    </View>
    <If when={section() === 'changes'}>
      <DesktopGitChanges git={git} revision={revision} active={active} disabled={disabled} run={run} onOpenDiff={props.onOpenDiff} onOpenFile={props.onOpenFile} />
      <If when={status()?.isClean}><Text class="p-2 text-xs text-muted-foreground">{t('gitView.empty.cleanTitle')}</Text></If>
      <View class="p-2 gap-2 border-t border-border/30"><Input testID="desktop-git-message" class={input} value={message()} placeholder={t('gitView.commit.messagePlaceholder')} multiline onChange={event => message.set(event.value)} /><View class="flex-row gap-1"><Button testID="desktop-git-commit" class={action} disabled={disabled() || !staged().length} onPress={() => { void commit(false); }}><Text class="text-xs text-foreground">{t('gitView.commit.commit')}</Text></Button><Button testID="desktop-git-commit-push" class={action} disabled={disabled() || !staged().length} onPress={() => { void commit(true); }}><Text class="text-xs text-foreground">{t('gitView.commit.push')}</Text></Button></View></View>
      <View class="p-1 flex-row gap-1"><Button testID="desktop-git-generate" class={action} disabled={disabled() || !staged().length || !!generationUnknown()} onPress={() => { void generateCommit(); }}><Text class="text-xs text-foreground">{t('gitView.commit.generate')}</Text></Button><Button testID="desktop-git-gitmoji" class={action} disabled={!active()} onPress={() => gitmojiOpen.set(!gitmojiOpen())}><Text class="text-xs text-foreground">{t('gitView.commit.addGitmoji')}</Text></Button></View>
      <If when={!!resource('generated').error}><Text role="alert" class="px-2 text-xs text-destructive">{resource('generated').error}</Text></If>
      <Each of={highlights()} key={line => line}>{line => <Button class={quiet} onPress={() => { if (active()) message.set(message().trimEnd() + '\n\n- ' + line()); }}><Text class="text-xs text-muted-foreground">{line()}</Text></Button>}</Each>
      <If when={gitmojiOpen()}><View style={{ height: 200 }}><Input testID="desktop-git-gitmoji-search" class={input} value={gitmojiSearch()} placeholder={t('gitView.gitmoji.searchPlaceholder')} onChange={event => gitmojiSearch.set(event.value)} /><List class="flex-1" each={(props.gitmojis ?? desktopGitmojis).filter(entry => `${entry.emoji} ${entry.code} ${entry.description}`.toLowerCase().includes(gitmojiSearch().toLowerCase()))} keyExtractor={entry => entry.code}>{entry => <Button testID={`desktop-git-gitmoji-${entry().code}`} class={quiet} onPress={() => { if (active()) { message.set(insertDesktopGitmoji(message(), entry())); gitmojiOpen.set(false); gitmojiSearch.set(''); } }}><Text class="text-xs text-foreground">{entry().emoji} {entry().code}</Text></Button>}</List></View></If>
    </If>
    <If when={section() === 'identity'}><DesktopGitIdentity {...props} git={git} revision={revision} active={active} disabled={disabled} run={run} remote={remote()} /></If>
    <If when={section() === 'pr'}><DesktopGitPullRequest {...props} git={git} revision={revision} active={active} disabled={disabled} run={run} remote={remote()} /></If>
    <If when={section() === 'worktree'}><DesktopGitWorktree {...props} git={git} revision={revision} active={active} disabled={disabled} run={run} remote={remote()} /></If>
    <If when={section() === 'branches'}>
      <View class="p-2 gap-1"><Input testID="desktop-git-branch-name" class={input} value={branch()} placeholder={t('gitView.branch.newBranchPlaceholder')} onChange={event => branch.set(event.value)} /><Button testID="desktop-git-create-branch" class={action} disabled={disabled() || !branch().trim()} onPress={() => { void run({ kind: 'branch', name: branch() }).then(ok => { if (ok && active()) branch.set(''); }); }}><Text class="text-xs text-foreground">{t('gitView.branch.create')}</Text></Button><Input testID="desktop-git-branch-search" class={input} value={search()} placeholder={t('gitView.branch.searchPlaceholder')} onChange={event => search.set(event.value)} /></View>
      <List class="flex-1" each={(resource('branches').value?.all ?? []).filter(name => name.toLowerCase().includes(search().toLowerCase()))} keyExtractor={name => name}>{name => <View class="px-2 gap-1">
        <Text class="text-sm text-foreground">{name()}{name() === status()?.current ? ' · ' + t('gitView.branch.currentBadge') : ''}</Text>
        <View class="flex-row flex-wrap gap-1"><Button testID={`desktop-git-checkout-${name()}`} class={quiet} disabled={disabled() || name() === status()?.current} onPress={() => { void run({ kind: 'checkout', branch: name() }); }}><Text class="text-xs text-foreground">{t('gitView.history.actions.checkout')}</Text></Button>
          <Each of={['merge', 'rebase'] as const}>{kind => <Button class={quiet} disabled={disabled() || name() === status()?.current} onPress={() => { void confirm(t(`gitView.operation.${kind()}`), name(), { kind: kind(), branch: name(), confirmed: true }); }}><Text class="text-xs text-foreground">{t(`gitView.operation.${kind()}`)}</Text></Button>}</Each>
          <Button class={quiet} disabled={disabled() || !branch().trim() || name().startsWith('remotes/')} onPress={() => { void run({ kind: 'rename', oldName: name(), newName: branch() }); }}><Text class="text-xs text-foreground">{t('gitView.branch.renameTitle')}</Text></Button>
          <Button class={quiet} disabled={disabled() || name() === status()?.current || name().startsWith('remotes/')} onPress={() => { void confirm(t('mobile.instances.delete'), name(), { kind: 'deleteBranch', branch: name(), confirmed: true }); }}><Text class="text-xs text-destructive">{t('mobile.instances.delete')}</Text></Button>
        </View>
      </View>}</List>
    </If>
    <If when={section() === 'stashes'}>
      <View class="p-2 gap-1"><Input testID="desktop-git-stash-message" class={input} value={stashMessage()} placeholder={t('gitView.stashes.messagePlaceholder')} onChange={event => stashMessage.set(event.value)} /><Button testID="desktop-git-stash" class={action} disabled={disabled() || status()?.isClean} onPress={() => { void run({ kind: 'stash', message: stashMessage() }); }}><Text class="text-xs text-foreground">{t('gitView.stashes.actions.stashCurrent')}</Text></Button><Text class="text-xs text-muted-foreground">{t('gitView.stashes.includeUntrackedHint')}</Text><Input class={input} value={search()} placeholder={t('gitView.stashes.searchPlaceholder')} onChange={event => search.set(event.value)} /></View>
      <If when={resource('stashes').loading}><Text class="p-2 text-xs text-muted-foreground">{t('common.loading')}</Text></If><If when={!!resource('stashes').error}><Text role="alert" class="p-2 text-xs text-destructive">{resource('stashes').error}</Text></If>
      <List class="flex-1" each={(resource('stashes').value ?? []).filter(stash => `${stash.ref} ${stash.message}`.toLowerCase().includes(search().toLowerCase()))} keyExtractor={stash => stash.ref}>{stash => <View class="p-2 gap-1"><Text class="text-sm text-foreground">{stash().ref} · {stash().message}</Text><View class="flex-row gap-1"><Each of={['apply', 'pop', 'drop'] as const}>{kind => <Button testID={`desktop-git-stash-${kind()}-${stash().ref}`} class={quiet} disabled={disabled()} onPress={() => { if (kind() === 'drop') void confirm(t('gitView.stashes.confirm.drop', { ref: stash().ref }), stash().message, { kind: 'stashDrop', ref: stash().ref, confirmed: true }); else void run({ kind: kind() === 'pop' ? 'stashPop' : 'stashApply', ref: stash().ref }); }}><Text class="text-xs text-foreground">{t(`gitView.stashes.actions.${kind()}`)}</Text></Button>}</Each></View></View>}</List>
      <If when={resource('stashes').value?.length === 0}><Text class="p-2 text-xs text-muted-foreground">{t('gitView.stashes.empty.list')}</Text></If>
    </If>
    <If when={section() === 'history' || section() === 'graph'}>
      <If when={resource('log').loading || fileLoading()}><Text class="p-2 text-xs text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!!resource('log').error || !!fileError()}><View class="p-2"><Text role="alert" class="text-xs text-destructive">{resource('log').error || fileError()}</Text><Button class={action} onPress={() => { if (fileError()) void selectCommit(selectedCommit()); else refreshSection(); }}><Text class="text-xs text-foreground">{t('diffView.actions.retry')}</Text></Button></View></If>
      <If when={!selectedCommit()}>
        <If when={section() === 'history'}><List class="flex-1" each={resource('log').value?.all ?? []} keyExtractor={commit => commit.hash}>{commit => <Button testID={`desktop-git-history-${commit().hash}`} class="p-2 gap-1 hover:bg-accent" onPress={() => { void selectCommit(commit().hash); }}><Text class="text-sm text-foreground">{commit().message}</Text><Text class="text-xs text-muted-foreground">{commit().hash.slice(0, 8)} · {commit().author_name} · {commit().date}</Text></Button>}</List></If>
        <If when={section() === 'graph'}><List class="flex-1" each={graph().rows} keyExtractor={row => row.commit.hash}>{row => <Button testID={`desktop-git-history-${row().commit.hash}`} class="flex-row items-center gap-2 hover:bg-accent" style={{ height: 64 }} onPress={() => { void selectCommit(row().commit.hash); }}><NativeDesktopGitGraphSegment row={row()} width={graph().width} /><View class="flex-1"><Text class="text-sm text-foreground" style={{ numberOfLines: 1 }}>{row().commit.message}</Text><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{row().commit.hash.slice(0, 8)} · {row().commit.refs}</Text></View></Button>}</List></If>
        <Button testID="desktop-git-history-more" class={action} disabled={resource('log').loading} onPress={() => { logCount.set(logCount() + 25); refreshSection(); }}><Text class="text-xs text-foreground">{t('gitView.history.loadMore')}</Text></Button>
      </If>
      <If when={!!selectedCommit()}>
        <View class="p-2 flex-row flex-wrap gap-1"><Button testID="desktop-git-history-back" class={quiet} onPress={() => { fileGeneration++; selectedCommit.set(''); files.set([]); diff.set(null); }}><Icon name="arrow-left" size={14} /><Text class="text-xs text-foreground">{t('gitView.history.title')}</Text></Button><Button class={quiet} onPress={() => { if (active()) void Clipboard.writeText(selectedCommit()).catch(cause => localError.set(String(cause))); }}><Text class="text-xs text-foreground">{t('gitView.history.copySha')}</Text></Button>
          <Each of={[
            { kind: 'checkoutCommit', key: 'checkout', confirm: 'checkoutConfirm' }, { kind: 'cherryPick', key: 'cherryPick', confirm: 'cherryPickConfirm' }, { kind: 'revertCommit', key: 'revert', confirm: 'revertConfirm' },
          ] as const}>{item => <Button class={quiet} disabled={disabled()} onPress={() => { void confirm(t(`gitView.history.actions.${item().key}`), t(`gitView.history.actions.${item().confirm}`), { kind: item().kind, hash: selectedCommit(), confirmed: true }); }}><Text class="text-xs text-foreground">{t(`gitView.history.actions.${item().key}`)}</Text></Button>}</Each>
          <Each of={['soft', 'mixed', 'hard'] as const}>{mode => <Button class={quiet} disabled={disabled()} onPress={() => { const key = { soft: 'resetSoft', mixed: 'resetMixed', hard: 'resetHard' } as const; void confirm(t(`gitView.history.actions.${key[mode()]}`), t(`gitView.history.actions.${key[mode()]}Confirm`), { kind: 'reset', hash: selectedCommit(), mode: mode(), confirmed: true }); }}><Text class="text-xs text-foreground">{t(`gitView.history.actions.${({ soft: 'resetSoft', mixed: 'resetMixed', hard: 'resetHard' } as const)[mode()]}`)}</Text></Button>}</Each>
        </View>
        <View class="p-2 flex-row gap-1"><Input class={input + ' flex-1'} value={branch()} placeholder={t('gitView.history.actions.createBranchPlaceholder')} onChange={event => branch.set(event.value)} /><Button class={action} disabled={disabled() || !branch().trim()} onPress={() => { void run({ kind: 'branch', name: branch(), startPoint: selectedCommit() }); }}><Text class="text-xs text-foreground">{t('gitView.history.actions.createBranch')}</Text></Button></View>
        <If when={!diff()}><List class="flex-1" each={files()} keyExtractor={file => file.path}>{file => <Button testID={`desktop-git-history-file-${file().path}`} class={quiet} onPress={() => { void selectDiff(file()); }}><Text class="flex-1 text-xs text-foreground">{file().path}</Text><Text class="text-xs text-muted-foreground">+{file().insertions} −{file().deletions}</Text></Button>}</List></If>
        <If when={!!diff()}><Button class={quiet} onPress={() => diff.set(null)}><Text class="text-xs text-foreground">{diff()?.path}</Text><Icon name="close" size={14} /></Button><If when={diff()?.isBinary}><Text class="p-2 text-xs text-muted-foreground">{t('gitView.history.binaryNoDiff')}</Text></If><If when={!diff()?.isBinary}><DesktopGitDiff testID="desktop-git-history-diff" class="flex-1" oldValue={diff()?.before ?? ''} newValue={diff()?.after ?? ''} layout="unified" inline="word" contextLines={3} lineNumbers /></If></If>
      </If>
      <If when={resource('log').value?.all.length === 0}><Text class="p-2 text-xs text-muted-foreground">{t('gitView.history.noCommits')}</Text></If>
    </If>
  </View>;
}
