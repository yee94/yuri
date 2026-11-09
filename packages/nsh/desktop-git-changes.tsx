import { computed, effect, List, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { DesktopGitDiff } from './desktop-git-diff';
import { buildChangesTree, flattenChangesTree } from '../ui/src/components/views/git/changesTree';
import { changeGroups, type ChangesSource } from './chat-changes-model';
import { Icon } from './Icon';
import { t } from './i18n';
import type { DesktopGitOwner, DesktopGitAction } from './desktop-git-model';

const action = 'min-h-8 px-2 rounded-md bg-secondary hover:bg-accent disabled:opacity-40 flex-row items-center justify-center gap-1';
const quiet = 'min-h-8 px-1 flex-row items-center gap-1 hover:bg-accent disabled:opacity-40';
export function DesktopGitChanges(props: { git: DesktopGitOwner; revision: () => number; active: () => boolean; disabled: () => boolean; run: (action: DesktopGitAction) => Promise<boolean>; onOpenDiff: (source: ChangesSource) => void; onOpenFile: (path: string, line?: number) => void }) {
  const selected = signal(new Set<string>()), expanded = signal(new Set<string>()), loaded = signal(false), hunkOpen = signal(false), hunkIndex = signal(0), error = signal('');
  const status = () => { props.revision(); return props.git.resource('status').value; };
  const patch = () => { props.revision(); return props.git.resource('patch'); };
  let groupedStatus: ReturnType<typeof status> | undefined, groupedLoaded = false, groupedRows: ReturnType<typeof changeGroups> = [];
  const groups = computed(() => {
    const snapshot = status(), materialized = loaded();
    if (snapshot === groupedStatus && materialized === groupedLoaded) return groupedRows;
    groupedStatus = snapshot; groupedLoaded = materialized;
    groupedRows = snapshot?.oversized && !materialized ? [] : changeGroups(snapshot);
    return groupedRows;
  });
  const trees = computed(() => groups().map(group => ({ staged: group.staged, tree: buildChangesTree(group.files) })));
  const rows = computed(() => trees().flatMap(group => flattenChangesTree(group.tree, expanded()).map(row => ({ ...row, staged: group.staged }))));
  const id = (path: string, staged: boolean) => JSON.stringify([path, staged]);
  const all = computed(() => groups().flatMap(group => group.files.map(file => ({ path: file.path, staged: group.staged }))));
  effect(() => {
    const available = new Set(all().map(file => id(file.path, file.staged)));
    untracked(() => { const next = new Set([...selected()].filter(key => available.has(key))); if (next.size !== selected().size) selected.set(next); });
  });
  function toggle(paths: string[], staged: boolean) {
    const next = new Set(selected()), keys = paths.map(path => id(path, staged)), remove = keys.every(key => next.has(key));
    for (const key of keys) { if (remove) next.delete(key); else next.add(key); } selected.set(next);
  }
  async function move(paths: string[], staged: boolean) { if (!props.disabled() && paths.length) await props.run({ kind: staged ? 'unstage' : 'stage', paths }); }
  async function restore(paths: string[], staged: boolean, directory?: string) {
    if (props.disabled() || !paths.length) return;
    const confirmed = await AlertDialog.show({ title: t(directory ? 'gitView.changes.revertDirectoryDialogTitle' : 'gitView.changes.revertAllDialogTitle'),
      description: t(directory ? paths.length === 1 ? 'gitView.changes.revertDirectoryDescriptionSingle' : 'gitView.changes.revertDirectoryDescriptionPlural' : paths.length === 1 ? 'gitView.changes.revertAllDescriptionSingle' : 'gitView.changes.revertAllDescriptionPlural', { path: directory || '', count: paths.length }),
      actions: [{ id: 'restore', label: t('gitView.changes.revertAll'), role: 'destructive' }, { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' }] });
    if (!props.active() || confirmed.action !== 'restore') return;
    // The Host has only single-path restore. Drain in order, stop at the first
    // failed/unknown result, keep the remaining paths selected and never replay.
    for (const path of paths) {
      if (!props.active() || props.git.writeUnknown()) break;
      if (!await props.run({ kind: 'restore', path, scope: staged ? 'all' : 'working', confirmed: true })) break;
    }
  }
  const chosen = (staged: boolean) => all().filter(file => file.staged === staged && selected().has(id(file.path, staged))).map(file => file.path);
  async function openHunks(path: string, staged: boolean) {
    if (!props.active()) return; hunkOpen.set(true); hunkIndex.set(0); await props.git.refreshPatch(path, staged);
  }
  async function applyHunk(discard = false) {
    const source = patch().value, index = hunkIndex(), hunk = source?.hunks[index];
    if (!source || !hunk || props.disabled()) return;
    if (discard) {
      const answer = await AlertDialog.show({ title: t('diffView.hunk.discardTitle', { index: index + 1 }), description: t('gitView.changes.revertAllDescriptionSingle', { count: 1 }), actions: [{ id: 'discard', label: t('diffView.hunk.discard'), role: 'destructive' }, { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' }] });
      if (!props.active() || answer.action !== 'discard') return;
    }
    await props.run({ kind: 'hunk', path: source.path, staged: source.staged, index, patch: hunk, action: discard ? 'discard' : source.staged ? 'unstage' : 'stage', ...(discard ? { confirmed: true } : {}) });
    hunkIndex.set(Math.min(index, Math.max(0, (patch().value?.hunks.length ?? 1) - 1)));
  }
  return <View testID="desktop-git-tree" class="flex-1">
    <If when={!hunkOpen()}>
      <If when={status()?.oversized && !loaded()}><View class="p-2 gap-1"><Text class="text-xs text-muted-foreground">{t('gitView.changes.deferredHint')}</Text><Button testID="desktop-git-load-changes" class={action} onPress={() => loaded.set(true)}><Text class="text-xs text-foreground">{t('gitView.changes.deferredLoadAction')}</Text></Button></View></If>
      <View class="p-1 flex-row flex-wrap gap-1">
        <Button testID="desktop-git-stage-all" class={action} disabled={props.disabled()} onPress={() => { void move(all().filter(file => !file.staged).map(file => file.path), false); }}><Text class="text-xs text-foreground">{t('gitView.changes.stageAllAria')}</Text></Button>
        <Button testID="desktop-git-unstage-all" class={action} disabled={props.disabled()} onPress={() => { void move(all().filter(file => file.staged).map(file => file.path), true); }}><Text class="text-xs text-foreground">{t('gitView.changes.unstageAllAria')}</Text></Button>
        <Button class={quiet} disabled={!props.active()} accessibilityLabel={t('gitView.changes.selectAllAria')} onPress={() => selected.set(new Set(all().map(file => id(file.path, file.staged))))}><Icon name="checkbox" size={14} /></Button>
        <Button class={quiet} disabled={!props.active()} accessibilityLabel={t('gitView.changes.clearSelectionAria')} onPress={() => selected.set(new Set())}><Icon name="close" size={14} /></Button>
        <Each of={[false, true]}>{staged => <If when={chosen(staged()).length > 0}><Button testID={`desktop-git-selected-${staged() ? 'unstage' : 'stage'}`} class={action} disabled={props.disabled()} onPress={() => { void move(chosen(staged()), staged()); }}><Text class="text-xs text-foreground">{t(staged() ? 'diffView.hunk.unstage' : 'diffView.hunk.stage')} ({chosen(staged()).length})</Text></Button><Button class={action} disabled={props.disabled()} onPress={() => { void restore(chosen(staged()), staged()); }}><Text class="text-xs text-destructive">{t('gitView.changes.revertFileTooltip')} ({chosen(staged()).length})</Text></Button></If>}</Each>
      </View>
      <List class="flex-1" each={rows()} keyExtractor={row => `${row.staged}:${row.key}`}>{row => <View class="min-h-8 flex-row items-center gap-1 pr-1" style={{ paddingLeft: 3 + row().depth * 14 }}>
        <Each of={[row()]} key={value => value}>{row => <>
        <If when={row().kind === 'directory'}>{() => {
          const item = row(); if (item.kind !== 'directory') return null; const paths = item.directory.files.map(file => file.path);
          return <>
            <Button testID={`desktop-git-folder-${item.staged ? 'staged' : 'working'}-${item.directory.path}`} class={quiet + ' flex-1'} onPress={() => { const next = new Set(expanded()); if (next.has(item.directory.path)) next.delete(item.directory.path); else next.add(item.directory.path); expanded.set(next); }}><Icon name={expanded().has(item.directory.path) ? 'arrow-down-s' : 'arrow-right-s'} size={14} /><Text class="text-xs text-foreground">{item.directory.name}</Text></Button>
            <Button testID={`desktop-git-select-folder-${item.staged ? 'staged' : 'working'}-${item.directory.path}`} class={quiet} selected={paths.every(path => selected().has(id(path, item.staged)))} accessibilityLabel={t('gitView.changes.toggleDirectorySelectionAria', { path: item.directory.path })} onPress={() => toggle(paths, item.staged)}><Icon name="checkbox" size={14} /></Button>
            <Button testID={`desktop-git-move-folder-${item.staged ? 'staged' : 'working'}-${item.directory.path}`} class={quiet} disabled={props.disabled()} accessibilityLabel={t(item.staged ? 'gitView.changes.unstageDirectoryAria' : 'gitView.changes.stageDirectoryAria', { path: item.directory.path })} onPress={() => { void move(paths, item.staged); }}><Icon name={item.staged ? 'subtract' : 'add'} size={14} /></Button>
            <Button testID={`desktop-git-restore-folder-${item.staged ? 'staged' : 'working'}-${item.directory.path}`} class={quiet} disabled={props.disabled()} accessibilityLabel={t('gitView.changes.revertDirectoryAria', { path: item.directory.path })} onPress={() => { void restore(paths, item.staged, item.directory.path); }}><Icon name="arrow-go-back" size={14} /></Button>
          </>;
        }}</If>
        <If when={row().kind === 'file'}>{() => {
          const item = row(); if (item.kind !== 'file') return null; const file = item.file;
          return <>
            <Button testID={`desktop-git-select-${item.staged ? 'staged' : 'working'}-${file.path}`} class={quiet} selected={selected().has(id(file.path, item.staged))} accessibilityLabel={t('gitView.changes.selectFileAria', { path: file.path })} onPress={() => toggle([file.path], item.staged)}><Icon name="checkbox" size={14} /></Button>
            <Button testID={`desktop-git-diff-${item.staged ? 'staged' : 'working'}-${file.path}`} class={quiet + ' flex-1'} onPress={() => { if (props.active()) props.onOpenDiff({ kind: 'workspace', directory: props.git.scope.directory, path: file.path, staged: item.staged }); }}><Text class="flex-1 text-xs text-foreground" style={{ numberOfLines: 1 }}>{file.path}</Text><Text class="text-xs text-muted-foreground">{item.staged ? t('gitView.changes.stagedTitle') : file.working_dir || file.index}</Text></Button>
            <Button testID={`desktop-git-index-${item.staged ? 'staged' : 'working'}-${file.path}`} class={quiet} disabled={props.disabled()} onPress={() => { void move([file.path], item.staged); }}><Icon name={item.staged ? 'subtract' : 'add'} size={14} /></Button>
            <Button testID={`desktop-git-hunks-${item.staged ? 'staged' : 'working'}-${file.path}`} class={quiet} accessibilityLabel={t('diffView.hunk.label')} onPress={() => { void openHunks(file.path, item.staged); }}><Icon name="file-edit" size={14} /></Button>
            <Button testID={`desktop-git-restore-${item.staged ? 'staged' : 'working'}-${file.path}`} class={quiet} disabled={props.disabled()} onPress={() => { void restore([file.path], item.staged); }}><Icon name="arrow-go-back" size={14} /></Button>
            <Button class={quiet} accessibilityLabel={t('diffView.actions.openFilePreview')} onPress={() => { if (props.active()) props.onOpenFile(file.path); }}><Icon name="eye" size={14} /></Button>
          </>;
        }}</If>
        </>}</Each>
      </View>}</List>
    </If>
    <If when={hunkOpen()}>
      <View class="p-1 gap-1"><View class="flex-row gap-1"><Button testID="desktop-git-hunks-back" class={quiet} onPress={() => hunkOpen.set(false)}><Icon name="arrow-left" size={14} /><Text class="text-xs text-foreground">{t('gitView.changes.title')}</Text></Button><Button testID="desktop-git-hunks-refresh" class={quiet} onPress={() => { void props.git.refreshPatch(); }}><Icon name="refresh" size={14} /></Button></View><Text class="text-xs text-muted-foreground">{patch().value?.path}</Text>
        <If when={patch().loading}><Text class="text-xs text-muted-foreground">{t('common.loading')}</Text></If><If when={!!patch().error || !!error()}><Text role="alert" class="text-xs text-destructive">{patch().error || error()}</Text></If>
      </View>
      <View style={{ height: Math.min(120, (patch().value?.hunks.length ?? 0) * 32) }}><List class="flex-1" each={patch().value?.hunks.map((hunk, index) => ({ hunk, index })) ?? []} keyExtractor={row => String(row.index)}>{row => <Button testID={`desktop-git-hunk-${row().index}`} class={quiet} selected={hunkIndex() === row().index} onPress={() => hunkIndex.set(row().index)}><Text class="text-xs text-foreground">{row().hunk.split('\n').find(line => line.startsWith('@@'))}</Text></Button>}</List></View>
      <If when={!!patch().value?.hunks[hunkIndex()]}><DesktopGitDiff testID="desktop-git-hunk-diff" class="flex-1" patch={patch().value?.hunks[hunkIndex()]} layout="unified" inline="word" lineNumbers contextLines={3} /><View class="p-1 flex-row gap-1"><Button testID="desktop-git-hunk-apply" class={action} disabled={props.disabled() || patch().loading || !!patch().error} onPress={() => { void applyHunk(); }}><Text class="text-xs text-foreground">{t(patch().value?.staged ? 'diffView.hunk.unstage' : 'diffView.hunk.stage')}</Text></Button><If when={!patch().value?.staged}><Button testID="desktop-git-hunk-discard" class={action} disabled={props.disabled() || patch().loading || !!patch().error} onPress={() => { void applyHunk(true); }}><Text class="text-xs text-destructive">{t('diffView.hunk.discard')}</Text></Button></If></View></If>
    </If>
  </View>;
}
