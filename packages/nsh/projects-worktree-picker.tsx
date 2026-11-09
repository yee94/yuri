import { Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeSelect } from './native-select';
import { Icon } from './Icon';
import { t } from './i18n';
import { nativeChatTextStyle, nativeDensity } from './appearance';
import { worktreeFormLayout } from './projects-presentation';
import { worktreeBranchResults } from './projects-worktree-branches';
import type { createWorktreeForm } from './projects-worktree-form';

export function WorktreeBranchPicker(props: { kind: 'source' | 'existing'; form: ReturnType<typeof createWorktreeForm>; disabled: boolean; fieldClass: string; quietClass: string }) {
  const form = props.form;
  const value = () => props.kind === 'source' ? form.source() : form.existingBranch();
  const label = () => t(props.kind === 'source' ? 'session.newWorktree.sourceBranch' : 'session.newWorktree.selectBranch');
  const layout = () => worktreeFormLayout(nativeDensity().scale);
  const textStyle = () => { const style = nativeChatTextStyle('uiLabel'); return { ...style, lineHeight: (style.fontSize ?? 13) * 1.5 }; };
  function refresh(testID: string) {
    return <Button testID={testID} class={props.quietClass} style={{ ...layout().control, minWidth: 36, paddingHorizontal: 0 }} disabled={props.disabled || form.contextLoading()} accessibilityLabel={t('session.newWorktree.fetchBranches')} onPress={() => { void form.prepare(); }}><Icon name="refresh" size={16} /></Button>;
  }
  return <View style={layout().group}><Text class="font-semibold text-foreground" style={textStyle()}>{label()}</Text><View class="flex-row items-center" style={layout().inline}>
    <NativeSelect testID={`projects-worktree-${props.kind}-branch`} class="flex-1" value={value() || null} disabled={props.disabled} items={form.branches().map(value => ({ value, title: value.replace(/^remotes\//, '') }))} searchable
      accessibilityLabel={label()} searchPlaceholder={t('session.newWorktree.searchBranches')}
      searchResults={query => {
        const result = worktreeBranchResults(form.branches(), query, t);
        return { items: result.items, notice: result.noMatches ? <Text testID="projects-worktree-no-matches" class="text-sm text-muted-foreground">{t('session.newWorktree.noMatchingBranches')}</Text> : undefined };
      }}
      listHeader={<View class="gap-2" style={nativeDensity().forms.compact}><View class="flex-row items-center gap-2" style={nativeDensity().forms.inline}><View class="flex-1"><If when={form.contextLoading()}><Text testID="projects-worktree-branches-loading" class="text-sm text-muted-foreground">{t('session.newWorktree.loadingBranches')}</Text></If></View>{refresh(`projects-worktree-picker-refresh-${props.kind}`)}</View><If when={form.contextError()}><Text testID="projects-worktree-picker-error" class="text-sm text-destructive">{form.contextError()}</Text><Button testID={`projects-worktree-picker-retry-${props.kind}`} class={props.quietClass} disabled={props.disabled || form.contextLoading()} onPress={() => { void form.prepare(); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button></If></View>}
      empty={<If when={!form.contextLoading() && !form.contextError()}><Text testID="projects-worktree-no-branches" class="text-sm text-muted-foreground">{t('session.newWorktree.noBranchesFound')}</Text></If>}
      onChange={event => { const next = event.value ?? ''; if (props.kind === 'source') form.selectSource(next); else form.selectExisting(next); }}
      trigger={<View class={`${props.fieldClass} flex-row items-center`} style={{ ...layout().control, ...layout().inline }}><Text class="flex-1 font-medium text-foreground" style={{ ...textStyle(), numberOfLines: 1 }}>{value() || t(props.kind === 'source' ? 'session.newWorktree.selectSourceBranchPlaceholder' : 'session.newWorktree.chooseBranch')}</Text><Icon name="git-branch" size={16} /></View>} />
    <If when={props.kind === 'existing'}>{refresh(`projects-worktree-refresh-${props.kind}`)}</If>
  </View></View>;
}
