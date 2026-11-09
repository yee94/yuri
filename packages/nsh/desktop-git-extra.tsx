import { computed, effect, List, openUrl, Scroll, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button, Input, Select, TextView } from 'nsh/base';
import { DesktopGitDiff } from './desktop-git-diff';
import { Icon } from './Icon';
import { t } from './i18n';
import type { DesktopPanelScope } from './desktop-panel-model';
import type { DesktopGitOwner, DesktopGitAction } from './desktop-git-model';
import type { DesktopGitWorktreeState } from './desktop-git-worktree-state';

const action = 'min-h-8 px-2 rounded-md bg-secondary hover:bg-accent disabled:opacity-40 flex-row items-center justify-center gap-1';
const input = 'min-h-8 px-2 rounded-md bg-secondary text-sm text-foreground';
export type DesktopGitAgentRequest = { scope: DesktopPanelScope; directory: string; target: 'current' | 'new'; kind: 'conflict' | 'integration' | 'pr' | 'checks' | 'comments'; visibleText: string; instructionsText: string; payload: unknown };
export type DesktopGitCallbacks = {
  onResolveWithAgent?: (request: DesktopGitAgentRequest) => void | Promise<void>;
  worktreeAttachment?: DesktopGitWorktreeState;
};
type SharedProps = DesktopGitCallbacks & { git: DesktopGitOwner; revision: () => number; active: () => boolean; disabled: () => boolean; run: (action: DesktopGitAction) => Promise<boolean>; remote: string };

export function DesktopGitIdentity(props: SharedProps) {
  const state = () => { props.revision(); return { identity: props.git.resource('identity'), global: props.git.resource('globalIdentity'), profiles: props.git.resource('profiles') }; };
  effect(() => { if (props.active()) untracked(() => { void props.git.refreshIdentities(); }); });
  return <View class="flex-1 p-2 gap-2">
    <Text class="text-sm text-foreground">{t('gitView.header.identityTooltip')}</Text>
    <Text class="text-xs text-muted-foreground">{[state().identity.value?.userName, state().identity.value?.userEmail].filter(Boolean).join(' · ') || t('gitView.header.noIdentity')}</Text>
    <Button testID="desktop-git-identity-refresh" class={action} onPress={() => { void props.git.refreshIdentities(); }}><Text class="text-xs text-foreground">{t('mobile.files.refreshAria')}</Text></Button>
    <Each of={[state().identity, state().global, state().profiles]}>{resource => <If when={!!resource().error}><Text role="alert" class="text-xs text-destructive">{resource().error}</Text></If>}</Each>
    <If when={!!state().global.value?.userName && !!state().global.value?.userEmail}><Button testID="desktop-git-identity-global" class={action} disabled={props.disabled()} onPress={() => { void props.run({ kind: 'identity', profileId: 'global' }); }}><Text class="text-xs text-foreground">{state().global.value?.userName} · {state().global.value?.userEmail}</Text></Button></If>
    <List class="flex-1" each={state().profiles.value ?? []} keyExtractor={profile => profile.id}>{profile => <Button testID={`desktop-git-identity-${profile().id}`} class={action} disabled={props.disabled()} onPress={() => { void props.run({ kind: 'identity', profileId: profile().id }); }}><Text class="text-xs text-foreground">{profile().name} · {profile().userName} · {profile().userEmail}</Text></Button>}</List>
    <If when={state().profiles.value?.length === 0}><Text class="text-xs text-muted-foreground">{t('gitView.header.noProfiles')}</Text></If>
  </View>;
}

export function DesktopGitPullRequest(props: SharedProps) {
  const title = signal(''), body = signal(''), base = signal(''), draft = signal(true), context = signal(''), error = signal(''), editing = signal(false);
  const upstreamSelected = signal(false), selectedFile = signal<string | null>(null), allDiff = signal(false);
  const state = () => { props.revision(); return props.git.resource('pr'); };
  const details = () => { props.revision(); return props.git.resource('prContext'); };
  const generated = () => { props.revision(); return props.git.resource('generated'); };
  const network = () => { props.revision(); return props.git.resource('upstream'); };
  const branches = () => { props.revision(); return props.git.resource('prBranches'); };
  const targetRepo = computed(() => upstreamSelected() ? network().value?.upstream : state().value?.repo);
  const repoIdentity = computed(() => { const repo = targetRepo(); return repo ? JSON.stringify([repo.owner, repo.repo]) : ''; });
  const file = computed(() => details().value?.files.find(file => file.filename === selectedFile()));
  const patch = computed(() => allDiff() ? details().value?.diff : file()?.patch ? `--- ${JSON.stringify('a/' + file()!.filename)}\n+++ ${JSON.stringify('b/' + file()!.filename)}\n${file()!.patch}` : '');
  const pr = () => state().value?.pr;
  const saving = computed(() => props.disabled() || state().loading);
  effect(() => { const remote = props.remote; if (props.active()) untracked(() => { void props.git.refreshPR(remote || 'origin'); void props.git.refreshUpstream(); }); });
  effect(() => { const identity = repoIdentity(); if (props.active() && identity) untracked(() => { const repo = targetRepo(); if (repo) void props.git.refreshPRBranches(repo); }); });
  function chooseRepo(upstream: boolean) {
    if (!props.active()) return;
    upstreamSelected.set(upstream); base.set('');
  }
  async function edit() { const current = pr(); if (!current) return; title.set(current.title); body.set(current.body); base.set(current.base); editing.set(true); }
  async function createOrUpdate() {
    if (saving()) return;
    const current = pr();
    if (current) { if (await props.run({ kind: 'prUpdate', number: current.number, title: title(), body: body() })) editing.set(false); return; }
    const target = targetRepo(), snapshot = { kind: 'prCreate' as const, title: title(), body: body(), base: base(), draft: draft(), remote: props.remote || undefined,
      ...(upstreamSelected() && target ? { targetRepo: { owner: target.owner, repo: target.repo }, headRemote: props.remote || 'origin' } : {}), confirmed: true as const };
    const answer = await AlertDialog.show({ title: t('gitView.pr.actions.createPr'), description: `${target ? target.owner + '/' + target.repo + '\n' : ''}${snapshot.base} ← ${props.git.resource('status').value?.current || ''}`, actions: [{ id: 'create', label: t('gitView.pr.actions.createPr') }, { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' }] });
    if (answer.action === 'create' && props.active() && target === targetRepo()) await props.run(snapshot);
  }
  async function generate() {
    const beforeTitle = title(), beforeBody = body(), beforeBase = base(), beforeRepo = repoIdentity();
    const upstream = network().value?.upstream;
    const comparisonRef = upstreamSelected() ? upstream && !network().error ? base() === upstream.defaultBranch && upstream.defaultBranchSha || (upstream.remoteName ? `${upstream.remoteName}/${base()}` : null) : null : base();
    if (await props.git.generate('pr', base(), context(), comparisonRef)) {
      const result = generated().value;
      if (props.active() && result?.purpose === 'pr' && beforeTitle === title() && beforeBody === body() && beforeBase === base() && beforeRepo === repoIdentity()) { title.set(result.title); body.set(result.body); }
    }
  }
  async function merge(method: 'merge' | 'squash' | 'rebase') {
    const current = pr(); if (!current || saving()) return;
    const answer = await AlertDialog.show({ title: t('gitView.pr.actions.mergePr'), description: current.title, actions: [{ id: 'merge', label: t(`gitView.pr.mergeMethod.${method}`), role: 'destructive' }, { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' }] });
    if (props.active() && answer.action === 'merge') await props.run({ kind: 'prMerge', number: current.number, method, confirmed: true });
  }
  async function agent(kind: 'pr' | 'checks' | 'comments') {
    if (!props.active() || !props.onResolveWithAgent) return;
    try {
      if (!await props.git.refreshPRContext() || !props.active()) return;
      const payload = details().value;
      const prefix = kind === 'pr' ? 'github.pr.review' : kind === 'checks' ? 'github.pr.checks.review' : 'github.pr.comments.review';
      const text = await props.git.agentPrompt(prefix, { pr_number: String(pr()?.number || '') });
      if (props.active()) await props.onResolveWithAgent({ scope: props.git.scope, directory: props.git.scope.directory, target: 'current', kind, ...text, payload });
    } catch (cause) { if (props.active()) error.set(String(cause)); }
  }
  return <Scroll class="flex-1"><View testID="desktop-git-pr" class="p-2 gap-2">
    <View class="flex-row gap-1"><Text class="flex-1 text-sm text-foreground">{t('gitView.pullRequest.title')}</Text><Button testID="desktop-git-pr-refresh" class={action} onPress={() => { void props.git.refreshPR(props.remote || 'origin'); }}><Icon name="refresh" size={14} /></Button></View>
    <If when={state().loading}><Text class="text-xs text-muted-foreground">{t('gitView.pr.checkingStatus')}</Text></If>
    <If when={!!state().error || !!details().error || !!error() || !!generated().error}><Text role="alert" class="text-xs text-destructive">{state().error || details().error || error() || generated().error}</Text></If>
    <If when={state().value?.connected === false}><Text class="text-xs text-muted-foreground">{t('gitView.pr.githubNotConnected')}</Text></If>
    <If when={!!pr()}><Text class="text-sm text-foreground">#{pr()?.number} · {pr()?.title}</Text><Text class="text-xs text-muted-foreground">{pr()?.state}{pr()?.draft ? ' · ' + t('gitView.pr.field.draft') : ''} · {pr()?.base} ← {pr()?.head}</Text><TextView markdown={pr()?.body ?? ''} selectable />
      <Button testID="desktop-git-pr-open" class={action} onPress={() => { const url = pr()?.url; if (props.active() && url && /^https:\/\//.test(url)) void openUrl(url).catch(cause => error.set(String(cause))); }}><Text class="text-xs text-foreground">{t('gitView.pr.actions.openOnGitHub')}</Text></Button>
      <Button testID="desktop-git-pr-edit" class={action} disabled={saving()} onPress={() => { void edit(); }}><Text class="text-xs text-foreground">{t('gitView.pr.actions.editPr')}</Text></Button>
      <If when={pr()?.draft}><Button testID="desktop-git-pr-ready" class={action} disabled={saving()} onPress={() => { const current = pr(); if (current) void props.run({ kind: 'prReady', number: current.number }); }}><Text class="text-xs text-foreground">{t('gitView.pr.actions.markReady')}</Text></Button></If>
      <If when={state().value?.canMerge && !pr()?.draft && pr()?.state === 'open'}><Each of={['merge', 'squash', 'rebase'] as const}>{method => <Button testID={`desktop-git-pr-merge-${method()}`} class={action} disabled={saving()} onPress={() => { void merge(method()); }}><Text class="text-xs text-foreground">{t(`gitView.pr.mergeMethod.${method()}`)}</Text></Button>}</Each></If>
      <Text class="text-xs text-muted-foreground">{state().value?.checks ? `${state().value?.checks?.state} · ${state().value?.checks?.success}/${state().value?.checks?.total}` : ''}</Text>
      <Button testID="desktop-git-pr-details" class={action} onPress={() => { void props.git.refreshPRContext(); }}><Text class="text-xs text-foreground">{t('gitView.pr.actions.openComments')} · {t('gitView.pr.actions.openChecks')}</Text></Button>
      <If when={!!props.onResolveWithAgent}><View class="flex-row flex-wrap gap-1"><Each of={['pr', 'checks', 'comments'] as const}>{kind => <Button class={action} disabled={!props.active() || !props.git.scope.sessionID} onPress={() => { void agent(kind()); }}><Text class="text-xs text-foreground">{t(kind() === 'pr' ? 'gitView.pr.actions.sendToAgent' : kind() === 'checks' ? 'gitView.pr.actions.resolveFailedChecks' : 'gitView.pr.actions.shareComments')}</Text></Button>}</Each></View></If>
    </If>
    <If when={state().value?.connected && (!pr() || editing())}>
      <If when={!pr()}><Text class="text-xs text-muted-foreground">{t('gitView.pr.actions.repo')}</Text><View class="flex-row flex-wrap gap-1">
        <Button testID="desktop-git-pr-target-remote" class={action} selected={!upstreamSelected()} onPress={() => chooseRepo(false)}><Text class="text-xs text-foreground">{state().value?.repo?.owner}/{state().value?.repo?.repo}</Text></Button>
        <If when={!!network().value?.upstream}><Button testID="desktop-git-pr-target-upstream" class={action} selected={upstreamSelected()} disabled={!!network().error || network().loading} onPress={() => chooseRepo(true)}><Text class="text-xs text-foreground">{network().value?.upstream?.owner}/{network().value?.upstream?.repo}</Text></Button></If>
      </View><If when={!!network().error || !!branches().error}><Text role="alert" class="text-xs text-destructive">{network().error || branches().error}</Text><Button class={action} onPress={() => { void props.git.refreshUpstream(); const repo = targetRepo(); if (repo) void props.git.refreshPRBranches(repo); }}><Text class="text-xs text-foreground">{t('mobile.files.refreshAria')}</Text></Button></If></If>
      <Input testID="desktop-git-pr-title" class={input} value={title()} placeholder={t('gitView.pr.placeholder.title')} onChange={event => title.set(event.value)} />
      <Input testID="desktop-git-pr-base" class={input} value={base()} placeholder={state().value?.defaultBranch || t('gitView.pr.placeholder.selectBaseBranch')} onChange={event => base.set(event.value)} />
      <If when={!pr()}><Select items={(branches().value?.branches ?? []).map(branch => ({ value: branch, title: branch }))} value={base() || null} searchable disabled={branches().loading || !!branches().error || !props.active()} onChange={event => { if (props.active()) base.set(event.value || ''); }} accessibilityLabel={t('gitView.pr.field.baseBranch')} trigger={<View testID="desktop-git-pr-base-picker" class={action}><Text class="text-xs text-foreground">{base() || t('gitView.pr.placeholder.selectBaseBranch')}</Text></View>} popupClass="bg-background p-2" itemClass={action} /></If>
      <Input testID="desktop-git-pr-body" class={input} value={body()} multiline placeholder={t('gitView.pr.placeholder.description')} onChange={event => body.set(event.value)} />
      <Input class={input} value={context()} multiline placeholder={t('gitView.pr.additionalContext.optional')} onChange={event => context.set(event.value)} />
      <If when={!pr()}><Button class={action} selected={draft()} onPress={() => draft.set(!draft())}><Text class="text-xs text-foreground">{t('gitView.pr.field.draft')} {draft() ? '✓' : ''}</Text></Button></If>
      <Button testID="desktop-git-pr-generate" class={action} disabled={saving() || generated().loading || !!props.git.generationUnknown()} onPress={() => { void generate(); }}><Text class="text-xs text-foreground">{t('gitView.commit.generate')}</Text></Button>
      <Button testID="desktop-git-pr-save" class={action} disabled={saving() || !title().trim() || !base().trim()} onPress={() => { void createOrUpdate(); }}><Text class="text-xs text-foreground">{t(pr() ? 'gitView.pr.actions.savePr' : 'gitView.pr.actions.createPr')}</Text></Button>
      <If when={editing()}><Button class={action} onPress={() => editing.set(false)}><Text class="text-xs text-foreground">{t('gitView.pr.actions.cancelEditing')}</Text></Button></If>
    </If>
    <Each of={details().value?.comments ?? []} key={comment => comment.id}>{comment => <View class="gap-1"><Text class="text-xs text-muted-foreground">{comment().author} · {comment().path || ''} {comment().line || ''}</Text><TextView markdown={comment().body} selectable /></View>}</Each>
    <Each of={details().value?.checks ?? []} key={check => check.id}>{check => <View class="gap-1"><Text class="text-xs text-foreground">{check().name} · {check().status} · {check().conclusion}</Text><TextView document={{ blocks: [{ type: 'codeBlock', code: check().details }] }} selectable /><If when={/^https:\/\//.test(check().detailsUrl)}><Button class={action} onPress={() => { if (props.active()) void openUrl(check().detailsUrl).catch(cause => error.set(String(cause))); }}><Text class="text-xs text-foreground">{t('gitView.pr.actions.openOnGitHub')}</Text></Button></If></View>}</Each>
    <Each of={details().value?.files ?? []} key={file => file.filename}>{file => <Button testID={`desktop-git-pr-file-${file().filename}`} class={action} selected={selectedFile() === file().filename && !allDiff()} onPress={() => { if (props.active()) { selectedFile.set(file().filename); allDiff.set(false); } }}><Text class="text-xs text-foreground">{file().filename} · {file().status} +{file().additions} −{file().deletions}</Text></Button>}</Each>
    <If when={!!details().value?.diff}><Button testID="desktop-git-pr-all-diff" class={action} selected={allDiff()} onPress={() => allDiff.set(!allDiff())}><Text class="text-xs text-foreground">{t('gitView.changes.title')}</Text></Button></If>
    <If when={!!file() && !file()?.patch && !allDiff()}><Text class="text-xs text-muted-foreground">{t('diffView.binary.unavailable')}</Text></If>
    <If when={!!patch()}><View style={{ height: 360 }}><DesktopGitDiff testID="desktop-git-pr-diff" class="flex-1" patch={patch() || ''} layout="unified" inline="word" lineNumbers contextLines={3} /></View></If>
  </View></Scroll>;
}

export function DesktopGitWorktree(props: SharedProps) {
  const target = signal(''), error = signal('');
  const resource = <K extends Parameters<DesktopGitOwner['resource']>[0]>(key: K) => { props.revision(); return props.git.resource(key); };
  const worktree = () => { props.revision(); return props.git.worktreeState(); };
  const state = () => worktree().attachment;
  const busy = () => { props.revision(); return props.git.pending() || !!props.git.writeUnknown(); };
  effect(() => { if (props.active()) untracked(() => { void props.git.refreshPrimaryRoot(); }); });
  async function confirmed(actionKind: 'worktreeInspect' | 'integratePlan' | 'integrateRun' | 'integrateContinue' | 'integrateAbort') {
    if (!props.active() || props.git.pending() || props.git.writeUnknown()) return;
    const title = actionKind === 'worktreeInspect' ? t('gitView.tabs.worktree') : t('gitView.integrate.title');
    const answer = await AlertDialog.show({ title, description: actionKind === 'worktreeInspect' ? props.git.scope.directory : `${resource('status').value?.current || ''} → ${target() || resource('integrationPlan').value?.targetBranch || ''}`, actions: [{ id: 'confirm', label: t(actionKind === 'integrateAbort' ? 'gitView.operation.abort' : 'gitView.history.actions.confirmButton') }, { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' }] });
    if (!props.active() || answer.action !== 'confirm') return;
    await props.run(actionKind === 'integratePlan' ? { kind: actionKind, targetBranch: target(), confirmed: true } : { kind: actionKind, confirmed: true });
  }
  async function agent(target: 'current' | 'new') {
    const result = resource('integration').value;
    if (!props.active() || !props.onResolveWithAgent || result?.kind !== 'conflict') return;
    const variables: Record<string, string> = { current_commit: result.state.currentCommit, target_branch: result.state.targetBranch, repo_root: result.state.repoRoot, temp_worktree_path: result.state.tempWorktreePath, source_branch: result.state.sourceBranch };
    try { const text = await props.git.agentPrompt('git.integrate.cherrypick.resolve', variables); if (props.active()) await props.onResolveWithAgent({ scope: props.git.scope, directory: result.state.tempWorktreePath, target, kind: 'integration', ...text, payload: result }); }
    catch (cause) { if (props.active()) error.set(String(cause)); }
  }
  return <Scroll class="flex-1"><View testID="desktop-git-worktree" class="p-2 gap-2">
    <Text class="text-sm text-foreground">{t('gitView.tabs.worktree')}</Text><Text class="text-xs text-muted-foreground">{resource('primaryRoot').value}</Text>
    <Button testID="desktop-git-worktree-inspect" class={action} disabled={!props.active() || busy()} onPress={() => { void confirmed('worktreeInspect'); }}><Text class="text-xs text-foreground">{t('gitView.tabs.worktree')} · {t('gitView.integrate.checking')}</Text></Button>
    <If when={!!state()}><Text class="text-xs text-muted-foreground">{state()?.worktreeStatus} · {state()?.headState} · {state()?.branch || ''} · {state()?.cwd || ''}</Text></If>
    <If when={worktree().featuresUnavailable}><Text class="text-xs text-muted-foreground">{t('gitView.empty.worktreeFeaturesUnavailable')}</Text></If>
    <If when={worktree().pending}><Text class="text-xs text-muted-foreground">{t('gitView.empty.worktreeSetupInProgress')}</Text></If>
    <If when={!!worktree().error}><Text role="alert" class="text-xs text-destructive">{worktree().error}</Text></If>
    <Text class="text-sm text-foreground">{t('gitView.integrate.title')}</Text>
    <Input testID="desktop-git-integrate-target" class={input} value={target()} placeholder={t('gitView.integrate.target')} onChange={event => target.set(event.value)} />
    <Each of={resource('branches').value?.all.filter(branch => branch !== resource('status').value?.current) ?? []} key={branch => branch}>{branch => <Button class={action} selected={target() === branch()} onPress={() => target.set(branch())}><Text class="text-xs text-foreground">{branch()}</Text></Button>}</Each>
    <Button testID="desktop-git-integrate-plan" class={action} disabled={props.disabled() || !target()} onPress={() => { void confirmed('integratePlan'); }}><Text class="text-xs text-foreground">{t('gitView.integrate.commitsToMove')}</Text></Button>
    <If when={!!resource('integrationPlan').value}><Each of={resource('integrationPlan').value?.commits ?? []} key={sha => sha}>{sha => <Text class="text-xs text-muted-foreground">{sha()}</Text>}</Each><Button testID="desktop-git-integrate-run" class={action} disabled={props.disabled() || !resource('integrationPlan').value?.commits.length} onPress={() => { void confirmed('integrateRun'); }}><Text class="text-xs text-foreground">{t('gitView.integrate.moveCommits')}</Text></Button></If>
    <If when={resource('integration').value?.kind === 'conflict'}>
      <Text class="text-xs text-destructive">{t('gitView.integrate.cherryPickConflictDescription')}</Text>
      <Button class={action} onPress={() => { void props.git.refreshIntegration(); }}><Text class="text-xs text-foreground">{t('mobile.files.refreshAria')}</Text></Button>
      <Each of={['integrateContinue', 'integrateAbort'] as const}>{kind => <Button testID={`desktop-git-${kind()}`} class={action} disabled={props.disabled()} onPress={() => { void confirmed(kind()); }}><Text class="text-xs text-foreground">{t(kind() === 'integrateAbort' ? 'gitView.operation.abort' : 'gitView.operation.continue')}</Text></Button>}</Each>
      <If when={!!props.onResolveWithAgent}><Each of={['current', 'new'] as const}>{target => <Button class={action} disabled={!props.active() || target() === 'current' && !props.git.scope.sessionID} onPress={() => { void agent(target()); }}><Text class="text-xs text-foreground">{t(target() === 'current' ? 'gitView.integrate.currentSession' : 'gitView.integrate.newSession')}</Text></Button>}</Each></If>
    </If>
    <If when={resource('integration').value?.kind === 'success'}><Text class="text-xs text-foreground">{t('gitView.branch.operationCompleted')}</Text></If>
    <Each of={['primaryRoot', 'worktree', 'integrationPlan', 'integration'] as const}>{key => <If when={!!resource(key()).error}><Text role="alert" class="text-xs text-destructive">{resource(key()).error}</Text></If>}</Each>
    <If when={!!error()}><Text role="alert" class="text-xs text-destructive">{error()}</Text></If>
  </View></Scroll>;
}
