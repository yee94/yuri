import { Scroll, Text, View, effect, signal, untracked } from 'nsh';
import { Button, Input, Sheet } from 'nsh/base';
import { t } from '../core/i18n';
import { colors } from '../core/theme';
import { Icon } from '../core/Icon';
import { PrimaryButton, QuietButton, alpha, fontSize } from '../core/ui';
import { normalizePath, sessionsFor, worktreesFor, type Worktree } from '../core/store';
import { request } from '../core/host';
import {
  normalizeBranch,
  remoteCreateWorktree,
  remoteDeleteWorktree,
  remoteWorktreeDirty,
  slugifyWorktree,
  type RemoteProject,
} from '../core/remote';

const sheetPopup = {
  backgroundColor: colors.background(),
  borderTopLeftRadius: 26,
  borderTopRightRadius: 26,
  maxHeight: '88%',
} as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;
const body = { padding: 18, gap: 14, paddingBottom: 'env(safe-area-inset-bottom)' } as const;

const field = {
  minHeight: 48,
  borderRadius: 12,
  paddingHorizontal: 12,
  fontSize: 16,
  color: colors.foreground(),
  backgroundColor: colors.muted(),
  placeholderColor: colors.mutedForeground(),
} as const;

const label = { fontSize: 13, fontWeight: '600', color: colors.foreground() } as const;
const hint = { fontSize: 12, color: colors.mutedForeground() } as const;
const errorText = { fontSize: 12, color: colors.destructive() } as const;

type Mode = 'new' | 'existing';
type Errors = { branch: string; folder: string; request: string };
const noErrors: Errors = { branch: '', folder: '', request: '' };

const directoryQuery = (path: string) => `directory=${encodeURIComponent(normalizePath(path))}`;

/** Web `NewWorktreeDialog`: source branch, existing branch, name and bounded validation. */
export function NewWorktreeSheet(props: {
  open: () => boolean;
  project: () => { path: string; remote?: RemoteProject };
  busy: () => boolean;
  onClose: () => void;
  onCreated: (path: string, remote: boolean) => void;
}) {
  const mode = signal<Mode>('new');
  const branch = signal('');
  const folder = signal('');
  const source = signal('');
  const existing = signal('');
  const existingFolder = signal('');
  const query = signal('');
  const branches = signal<string[]>([]);
  const loading = signal(false);
  const contextError = signal('');
  const errors = signal<Errors>(noErrors);
  const touched = signal(false);
  const validating = signal(false);
  const submitting = signal(false);
  let contextRevision = 0;
  let validationRevision = 0;

  const takenNames = () => {
    const project = props.project();
    if (project.remote) return [];
    return worktreesFor(project.path).flatMap((tree) => [tree.name, tree.branch]).filter(Boolean);
  };

  const reset = () => {
    contextRevision += 1;
    validationRevision += 1;
    mode.set('new');
    branch.set('');
    folder.set('');
    source.set('');
    existing.set('');
    existingFolder.set('');
    query.set('');
    branches.set([]);
    loading.set(false);
    contextError.set('');
    errors.set(noErrors);
    touched.set(false);
    validating.set(false);
    submitting.set(false);
  };

  const prepare = async () => {
    const project = props.project();
    const serial = ++contextRevision;
    loading.set(true);
    contextError.set('');
    try {
      if (!project.remote) {
        const catalog = (await request(`/api/git/branches?${directoryQuery(project.path)}`)) as { all?: unknown };
        if (!Array.isArray(catalog?.all) || !catalog.all.every((value) => typeof value === 'string')) {
          throw new Error('Invalid branch catalog');
        }
        const all = catalog.all as string[];
        const root = (await request(`/api/git/primary-root?${directoryQuery(project.path)}`)) as { root?: unknown };
        const rootPath = typeof root?.root === 'string' ? root.root : project.path;
        const status = (await request(`/api/git/status?${directoryQuery(rootPath)}`)) as { current?: unknown };
        if (serial !== contextRevision) return;
        branches.set(all);
        const start = typeof status?.current === 'string' && status.current ? status.current : (all[0] ?? '');
        source.set(start);
        const taken = new Set(takenNames());
        let next = '';
        for (let index = 0; index < 20 && !next; index += 1) {
          const candidate = `change-${Math.random().toString(36).slice(2, 8)}`;
          if (!taken.has(candidate) && !all.includes(candidate)) next = candidate;
        }
        branch.set(next);
        folder.set(slugifyWorktree(next));
        return;
      }
      const remote = project.remote;
      const payload = (await request(
        `/api/hosts/${encodeURIComponent(remote.hostId)}/api/git/branches?${directoryQuery(project.path)}`,
      )) as { all?: unknown };
      if (!Array.isArray(payload?.all) || !payload.all.every((value) => typeof value === 'string')) {
        throw new Error('Invalid branch catalog');
      }
      if (serial !== contextRevision) return;
      const all = payload.all as string[];
      branches.set(all);
      source.set(all[0] ?? '');
      const candidate = `change-${Math.random().toString(36).slice(2, 8)}`;
      branch.set(candidate);
      folder.set(slugifyWorktree(candidate));
    } catch (error) {
      if (serial === contextRevision) contextError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (serial === contextRevision) loading.set(false);
    }
  };

  effect(() => {
    const open = props.open();
    untracked(() => {
      if (!open) return;
      reset();
      void prepare();
    });
  });

  const selectedBranch = () => (mode() === 'new' ? branch() : existing());
  const selectedFolder = () => (mode() === 'new' ? folder() : existingFolder());
  const branchQuery = () => (mode() === 'new' ? source() : existing());
  const filtered = () => {
    const value = query().trim().toLowerCase();
    const all = branches();
    return value ? all.filter((entry) => entry.toLowerCase().includes(value)) : all;
  };

  const validate = async () => {
    const project = props.project();
    const serial = ++validationRevision;
    const branchName = normalizeBranch(selectedBranch());
    const worktreeName = slugifyWorktree(selectedFolder());
    const next: Errors = { ...noErrors };
    if (!branchName) next.branch = t('session.newWorktree.error.branchNameRequired');
    if (!worktreeName) next.folder = t('session.newWorktree.error.worktreeDirectoryRequired');
    if (next.branch || next.folder) {
      errors.set(next);
      validating.set(false);
      return;
    }
    const payload = {
      mode: mode(),
      ...(mode() === 'new' ? { branchName, ...(source() ? { startRef: source() } : {}) } : { existingBranch: branchName }),
      worktreeName,
    };
    validating.set(true);
    try {
      const response = project.remote
        ? await request(
            `/api/hosts/${encodeURIComponent(project.remote.hostId)}/api/git/worktrees/validate?${directoryQuery(project.path)}`,
            'POST',
            payload,
          )
        : await request(`/api/git/worktrees/validate?${directoryQuery(project.path)}`, 'POST', payload);
      const value = response as { ok?: unknown; errors?: unknown };
      if (typeof value?.ok !== 'boolean') throw new Error('Invalid worktree validation');
      if (value.ok === false) {
        for (const entry of Array.isArray(value.errors) ? value.errors : []) {
          const row = entry as { code?: unknown; message?: unknown };
          const code = typeof row.code === 'string' ? row.code : '';
          const message = typeof row.message === 'string' ? row.message : '';
          if (code === 'worktree_exists') next.folder ||= message;
          else if (code.startsWith('branch_')) next.branch ||= message;
          else next.request ||= message;
        }
        if (!next.branch && !next.folder && !next.request) next.request = t('session.newWorktree.error.createWorktreeFailed');
      }
      if (serial === validationRevision) errors.set(next);
    } catch (error) {
      if (serial === validationRevision) errors.set({ ...next, request: error instanceof Error ? error.message : String(error) });
    } finally {
      if (serial === validationRevision) validating.set(false);
    }
  };

  let validationTimer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const open = props.open();
    const checked = touched();
    mode();
    selectedBranch();
    selectedFolder();
    source();
    untracked(() => {
      if (validationTimer !== undefined) clearTimeout(validationTimer);
      if (!open || !checked) return;
      validationTimer = setTimeout(() => void validate(), 300);
    });
  });

  const submit = async () => {
    if (submitting() || props.busy()) return;
    const project = props.project();
    const branchName = normalizeBranch(selectedBranch());
    const worktreeName = slugifyWorktree(selectedFolder());
    if (!branchName || !worktreeName) {
      errors.set({
        ...errors(),
        ...(branchName ? {} : { branch: t('session.newWorktree.error.branchNameRequired') }),
        ...(worktreeName ? {} : { folder: t('session.newWorktree.error.worktreeDirectoryRequired') }),
      });
      return;
    }
    submitting.set(true);
    const failure = errors().branch || errors().folder || errors().request;
    if (failure) {
      submitting.set(false);
      return;
    }
    try {
      if (project.remote) {
        const path = await remoteCreateWorktree(project.remote, {
          mode: mode(),
          branch: branchName,
          folder: worktreeName,
          source: source(),
        });
        props.onCreated(path, true);
      } else {
        const payload = {
          mode: mode(),
          ...(mode() === 'new' ? { branchName, ...(source() ? { startRef: source() } : {}) } : { existingBranch: branchName }),
          worktreeName,
        };
        const created = (await request(`/api/git/worktrees?${directoryQuery(project.path)}`, 'POST', payload)) as {
          path?: unknown;
        };
        if (typeof created?.path !== 'string' || !created.path) throw new Error('Invalid created worktree');
        props.onCreated(created.path, false);
      }
    } catch (error) {
      errors.set({ ...errors(), request: error instanceof Error ? error.message : String(error) });
    } finally {
      submitting.set(false);
    }
  };

  const pickBranch = (value: string) => {
    touched.set(true);
    if (mode() === 'new') {
      source.set(value);
      return;
    }
    existing.set(value);
    existingFolder.set(slugifyWorktree(value.replace(/^remotes\//, '')));
  };

  return (
    <Sheet
      open={props.open()}
      closeOnSwipe={!submitting()}
      closeOnBackdropPress={!submitting()}
      onOpenChange={(event) => {
        if (!event.open && !submitting()) props.onClose();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View>
        <View style={{ paddingHorizontal: 18, paddingTop: 16, gap: 4 }}>
          <Text style={{ fontSize: 18, fontWeight: '600', color: colors.foreground() }}>{t('session.newWorktree.title')}</Text>
          <Text style={hint}>{props.project().path}</Text>
        </View>
        <Scroll style={{ maxHeight: 430 }} keyboardShouldPersistTaps="handled" contentStyle={body}>
          <View style={{ flexDirection: 'row', borderRadius: 12, backgroundColor: colors.muted(), padding: 3, gap: 3 }}>
            <Each of={[{ id: 'new' as const }, { id: 'existing' as const }]} key={(entry) => entry.id}>
              {(entry) => (
                <Button
                  testID={`worktree-mode-${entry().id}`}
                  onPress={() => {
                    touched.set(true);
                    mode.set(entry().id);
                  }}
                  style={{
                    flex: 1,
                    minHeight: 38,
                    borderRadius: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: mode() === entry().id ? alpha(colors.background(), 0.9) : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.foreground() }}>
                    {entry().id === 'new'
                      ? t('session.newWorktree.mode.newBranch')
                      : t('session.newWorktree.mode.existingBranch')}
                  </Text>
                </Button>
              )}
            </Each>
          </View>

          <If when={!!contextError()}>
            <View style={{ gap: 8 }}>
              <Text style={errorText}>{contextError()}</Text>
              <QuietButton label={() => t('layout.browserProvider.retry')} onPress={() => void prepare()} />
            </View>
          </If>

          <If when={mode() === 'new'}>
            <View style={{ gap: 6 }}>
              <Text style={label}>{t('session.newWorktree.branchName')}</Text>
              <Input
                testID="worktree-branch"
                value={branch()}
                onChange={(event) => {
                  touched.set(true);
                  branch.set(event.value);
                  folder.set(slugifyWorktree(event.value));
                }}
                placeholder={t('session.newWorktree.branchNamePlaceholder')}
                autoCapitalize="none"
                autoCorrect={false}
                style={field}
              />
              <If when={!!errors().branch}>
                <Text testID="worktree-branch-error" style={errorText}>{errors().branch}</Text>
              </If>
            </View>
          </If>

          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[label, { flex: 1 }]}>{t('session.newWorktree.worktreeDirectory')}</Text>
              <If when={mode() === 'new'}>
                <Button
                  onPress={() => {
                    touched.set(true);
                    folder.set(slugifyWorktree(branch()));
                  }}
                  style={{ minHeight: 30, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4 }}
                >
                  <Icon name="refresh" size={11} tone="muted" />
                  <Text style={hint}>{t('session.newWorktree.actions.reset')}</Text>
                </Button>
              </If>
            </View>
            <Input
              testID="worktree-folder"
              value={selectedFolder()}
              onChange={(event) => {
                touched.set(true);
                if (mode() === 'new') folder.set(event.value);
                else existingFolder.set(event.value);
              }}
              placeholder={t('session.newWorktree.worktreeDirectoryPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              style={field}
            />
            <If when={!!errors().folder}>
              <Text testID="worktree-folder-error" style={errorText}>{errors().folder}</Text>
            </If>
          </View>

          <View style={{ gap: 6 }}>
            <Text style={label}>
              {mode() === 'new' ? t('session.newWorktree.sourceBranch') : t('session.newWorktree.selectBranch')}
            </Text>
            <Input
              testID="worktree-branch-search"
              value={query()}
              onChange={(event) => query.set(event.value)}
              placeholder={t('session.newWorktree.searchBranches')}
              autoCapitalize="none"
              autoCorrect={false}
              style={[field, { minHeight: 40, fontSize: 14 }]}
            />
            <If when={loading()}>
              <Text style={hint}>{t('session.newWorktree.loadingBranches')}</Text>
            </If>
            <If when={!loading() && filtered().length === 0}>
              <Text style={hint}>{t('session.newWorktree.noBranchesFound')}</Text>
            </If>
            <View style={{ gap: 4 }}>
              <Each of={filtered().slice(0, 40)} key="index">
                {(entry) => (
                  <Button
                    testID={`worktree-branch-${entry()}`}
                    onPress={() => pickBranch(entry())}
                    style={{
                      minHeight: 40,
                      borderRadius: 10,
                      paddingHorizontal: 10,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      backgroundColor: branchQuery() === entry() ? alpha(colors.mutedForeground(), 0.12) : 'transparent',
                    }}
                  >
                    <Icon name="git-branch" size={13} tone="muted" />
                    <Text style={{ flex: 1, fontSize: 13, color: colors.foreground(), numberOfLines: 1 }}>{entry()}</Text>
                    <If when={branchQuery() === entry()}>
                      <Icon name="check" size={13} color={() => colors.success()} />
                    </If>
                  </Button>
                )}
              </Each>
            </View>
            <If when={mode() === 'new' && !!source()}>
              <Text style={hint}>{t('session.newWorktree.newBranchFromSource', { source: source() })}</Text>
            </If>
          </View>

          <If when={!!errors().request}>
            <Text testID="worktree-validation-error" style={errorText}>{errors().request}</Text>
          </If>
        </Scroll>
        <View style={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 'env(safe-area-inset-bottom)', gap: 8 }}>
          <If when={validating()}>
            <Text style={[hint, { textAlign: 'center' }]}>{t('common.loading')}</Text>
          </If>
          <PrimaryButton
            label={() => (submitting() ? t('session.newWorktree.actions.creating') : t('session.newWorktree.actions.createWorktree'))}
            disabled={() =>
              submitting() ||
              props.busy() ||
              validating() ||
              !normalizeBranch(selectedBranch()) ||
              !slugifyWorktree(selectedFolder())
            }
            busy={submitting}
            onPress={() => void submit()}
          />
          <Button
            onPress={() => {
              if (!submitting()) props.onClose();
            }}
            style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ fontSize: 15, color: colors.mutedForeground() }}>{t('gitView.common.cancel')}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}

/** Web `MobileDeleteWorktreeDialog`: dirty checkout warning, branch options, confirm. */
export function DeleteWorktreeSheet(props: {
  open: () => boolean;
  project: () => { path: string; remote?: RemoteProject };
  tree: () => Worktree | null;
  onClose: () => void;
  onDeleted: (deleted: boolean) => void;
}) {
  const dirty = signal(false);
  const checking = signal(false);
  const deleting = signal(false);
  const error = signal('');
  const localBranch = signal(true);
  const remoteBranch = signal(false);

  const reset = () => {
    dirty.set(false);
    checking.set(false);
    deleting.set(false);
    error.set('');
    localBranch.set(true);
    remoteBranch.set(false);
  };

  effect(() => {
    const open = props.open();
    const tree = props.tree();
    untracked(() => {
      if (!open) return;
      reset();
      if (!tree) return;
      checking.set(true);
      void (async () => {
        try {
          const project = props.project();
          if (project.remote) dirty.set(await remoteWorktreeDirty(project.remote.hostId, tree.path));
          else {
            const status = (await request(`/api/git/status?${directoryQuery(tree.path)}`)) as { isClean?: unknown };
            if (typeof status?.isClean !== 'boolean') throw new Error('Invalid worktree status');
            dirty.set(!status.isClean);
          }
        } catch (cause) {
          error.set(cause instanceof Error ? cause.message : String(cause));
        } finally {
          checking.set(false);
        }
      })();
    });
  });

  const attached = () => {
    const tree = props.tree();
    if (!tree || props.project().remote) return 0;
    return sessionsFor(tree.path).filter((row) => !row.parentID && !row.archived).length;
  };

  const remove = async () => {
    const tree = props.tree();
    if (!tree || deleting()) return;
    deleting.set(true);
    error.set('');
    try {
      const project = props.project();
      if (project.remote) {
        await remoteDeleteWorktree(project.remote, tree, {
          deleteLocalBranch: !!tree.branch.trim() && localBranch(),
          deleteRemoteBranch: remoteBranch(),
        });
      } else {
        for (const row of sessionsFor(tree.path).filter((entry) => !entry.parentID && !entry.archived)) {
          await request(`/api/yuri/sessions/${encodeURIComponent(row.id)}/archive`, 'PUT', {
            archivedAt: Date.now(),
            directory: tree.path,
          });
        }
        const removed = (await request(
          `/api/git/worktrees?${directoryQuery(project.path)}`,
          'DELETE',
          { directory: tree.path, deleteLocalBranch: !!tree.branch.trim() && localBranch() },
        )) as { success?: unknown };
        if (removed?.success !== true) throw new Error('Worktree removal failed');
        if (remoteBranch() && tree.branch.trim()) {
          const branchRemoval = (await request(
            `/api/git/remote-branches?${directoryQuery(project.path)}`,
            'DELETE',
            { branch: tree.branch.replace(/^refs\/heads\//, '').trim() },
          )) as { success?: unknown };
          if (branchRemoval?.success !== true) throw new Error('Remote branch removal failed');
        }
      }
      props.onDeleted(true);
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      deleting.set(false);
    }
  };

  return (
    <Sheet
      open={props.open()}
      closeOnSwipe={!deleting()}
      onOpenChange={(event) => {
        if (!event.open && !deleting()) props.onClose();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View style={body}>
        <Text style={{ fontSize: 18, fontWeight: '600', color: colors.foreground() }}>
          {t('mobile.projectEdit.deleteWorktreeTitle')}
        </Text>
        <Text style={hint}>
          {t('mobile.projectEdit.deleteWorktreeConfirm', { name: props.tree()?.name ?? '' })}
        </Text>
        <If when={checking()}>
          <Text style={hint}>{t('common.loading')}</Text>
        </If>
        <If when={dirty()}>
          <Text testID="worktree-dirty" style={{ fontSize: 13, color: colors.destructive() }}>
            {t('mobile.projectEdit.deleteWorktreeDirty')}
          </Text>
        </If>
        <If when={attached() > 0}>
          <Text style={hint}>{t('mobile.projectEdit.deleteWorktreeArchiveNote', { count: attached() })}</Text>
        </If>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Button
              testID="worktree-delete-local-branch"
              onPress={() => localBranch.set(!localBranch())}
              style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: localBranch() ? colors.foreground() : colors.border(),
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: localBranch() ? colors.foreground() : 'transparent',
                }}
              >
                <If when={localBranch()}>
                  <Icon name="check" size={12} color={() => colors.background()} />
                </If>
              </View>
              <Text style={{ fontSize: 13, color: colors.foreground() }}>{t('mobile.projectEdit.deleteLocalBranch')}</Text>
            </Button>
          </View>
          <Button
            testID="worktree-delete-remote-branch"
            onPress={() => remoteBranch.set(!remoteBranch())}
            style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8 }}
          >
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: remoteBranch() ? colors.foreground() : colors.border(),
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: remoteBranch() ? colors.foreground() : 'transparent',
              }}
            >
              <If when={remoteBranch()}>
                <Icon name="check" size={12} color={() => colors.background()} />
              </If>
            </View>
            <Text style={{ fontSize: 13, color: colors.foreground() }}>{t('mobile.projectEdit.deleteRemoteBranch')}</Text>
          </Button>
        </View>
        <If when={!!error()}>
          <Text style={errorText}>{error()}</Text>
        </If>
        <PrimaryButton
          label={() => (deleting() ? t('common.loading') : t('mobile.projectEdit.deleteWorktreeConfirmButton'))}
          disabled={() => deleting() || checking()}
          busy={deleting}
          onPress={() => void remove()}
        />
        <QuietButton label={() => t('gitView.common.cancel')} onPress={() => props.onClose()} disabled={() => deleting()} />
      </View>
    </Sheet>
  );
}
