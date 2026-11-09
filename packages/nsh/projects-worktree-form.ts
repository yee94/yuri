import { cleanup, effect, signal, Storage, untracked } from 'nsh';
import { normalizeBranchName, slugifyWorktreeName } from '../ui/src/lib/worktrees/worktreeNames';
import { resolveWorktreeSourceBranchPreference, resolveWorktreeSourceBranchToPersist } from '../ui/src/lib/worktrees/worktreeSourceBranchPreference';
import { generateBranchSlug } from '../ui/src/lib/git/branchNameGenerator';
import { record, text } from './model';
import { query } from './runtime';
import { t } from './i18n';
import type { PageOperation } from './page-operations';

export function uniqueWorktreeName(taken: ReadonlySet<string>, generate = generateBranchSlug) {
  for (let i = 0; i < 10; i++) { const value = generate(); if (!taken.has(value)) return value; }
  const base = generate(); let suffix = 1;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

type Options = {
  directory: string;
  hostKey: string;
  active: () => boolean;
  current: () => boolean;
  capture: () => PageOperation;
  worktrees: () => Array<{ name: string; branch: string }> | undefined;
};
type FieldErrors = { branch: string; folder: string; request: string };
const emptyErrors = (): FieldErrors => ({ branch: '', folder: '', request: '' });

/** One open form owns defaults, device preference and bounded, stale-fenced validation. */
export function createWorktreeForm(options: Options) {
  const initial = generateBranchSlug(), branch = signal(initial), folder = signal(initial), source = signal('');
  const existingBranch = signal(''), existingFolder = signal(''), mode = signal<'new' | 'existing'>('new');
  const branches = signal<string[]>([]), ready = signal(false), contextError = signal(''), contextLoading = signal(false), errors = signal(emptyErrors());
  const touched = signal(false), validating = signal(false), submitting = signal(false), confirmedPath = signal(''), retry = signal(0);
  let alive = true, revision = 0, contextRevision = 0, sourceRevision = 0, namesEdited = false, live = false;
  let validationFlight = false, queued: (() => void) | undefined;
  const memoryKey = `worktree-source-v1:${options.hostKey}`;
  const selectedBranch = () => mode() === 'new' ? branch() : existingBranch();
  const selectedFolder = () => mode() === 'new' ? folder() : existingFolder();
  const active = () => alive && options.active() && options.current();
  const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);
  function reset() {
    revision++; sourceRevision++; namesEdited = false;
    ready.set(false); contextError.set('');
    const next = generateBranchSlug(); branch.set(next); folder.set(next); source.set('');
    existingBranch.set(''); existingFolder.set(''); mode.set('new'); touched.set(false); errors.set(emptyErrors()); confirmedPath.set('');
  }
  async function prepare() {
    if (!active() || contextLoading()) return;
    const operation = options.capture(), serial = ++contextRevision, sourceAtStart = sourceRevision;
    const valid = () => active() && operation.current() && contextRevision === serial;
    contextError.set(''); contextLoading.set(true);
    try {
      const [catalog, root, saved] = await Promise.all([
        operation.request(`/api/git/branches?${query(options.directory)}`),
        operation.request(`/api/git/primary-root?${query(options.directory)}`),
        Storage.getItem(memoryKey),
      ]);
      if (!valid()) return;
      const all = record(catalog).all, rootPath = text(record(root).root);
      if (!Array.isArray(all) || !all.every(value => typeof value === 'string') || !rootPath) throw new Error('Invalid worktree branch context');
      const status = record(await operation.request(`/api/git/status?${query(rootPath)}`));
      if (typeof status.current !== 'string' && status.current !== null) throw new Error('Invalid root branch status');
      if (!valid()) return;
      branches.set(all);
      const preference = resolveWorktreeSourceBranchPreference({ branches: all, rootBranch: text(status.current) || null, savedSourceBranch: saved });
      if (preference.shouldClearSavedSourceBranch) await Storage.removeItem(memoryKey);
      if (!valid()) return;
      if (sourceAtStart === sourceRevision && !source()) source.set(preference.sourceBranch);
      ready.set(true);
    } catch (failure) { if (valid()) contextError.set(message(failure)); }
    finally { if (valid()) contextLoading.set(false); }
  }
  effect(() => {
    const enabled = active();
    untracked(() => {
      if (!enabled) { live = false; contextRevision++; revision++; queued = undefined; contextLoading.set(false); validating.set(false); submitting.set(false); return; }
      if (!live) { live = true; void prepare(); }
    });
  });
  effect(() => {
    const catalog = options.worktrees(), all = branches();
    if (!active() || !catalog) return;
    untracked(() => {
      if (namesEdited) return;
      const taken = new Set([...catalog.flatMap(row => [row.name, row.branch]), ...all]);
      if (taken.has(branch()) || taken.has(folder())) { const next = uniqueWorktreeName(taken); branch.set(next); folder.set(next); }
    });
  });
  effect(() => {
    const enabled = active(), checked = touched(), loaded = ready(), busy = submitting(), created = confirmedPath();
    const snapshot = { mode: mode(), branch: selectedBranch(), folder: selectedFolder(), source: source() }; retry();
    const serial = ++revision;
    untracked(() => { queued = undefined; validating.set(false); if (!created && !busy) errors.set(emptyErrors()); });
    if (!enabled || !checked || !loaded || busy || created) return;
    untracked(() => validating.set(true));
    const operation = options.capture();
    const valid = () => active() && operation.current() && revision === serial;
    const run = async () => {
      if (!valid()) return;
      if (validationFlight) { queued = () => { void run(); }; return; }
      const branchName = normalizeBranchName(snapshot.branch), worktreeName = slugifyWorktreeName(snapshot.folder);
      const result = emptyErrors();
      if (!branchName) result.branch = t('session.newWorktree.error.branchNameRequired');
      if (!worktreeName) result.folder = t('session.newWorktree.error.worktreeDirectoryRequired');
      if (!branchName || !worktreeName) { errors.set(result); validating.set(false); return; }
      validationFlight = true; validating.set(true);
      try {
        const response = record(await operation.request(`/api/git/worktrees/validate?${query(options.directory)}`, 'POST', {
          mode: snapshot.mode, ...(snapshot.mode === 'new' ? { branchName, ...(snapshot.source ? { startRef: snapshot.source } : {}) } : { existingBranch: branchName }), worktreeName,
        }));
        if (typeof response.ok !== 'boolean' || (response.ok === false && !Array.isArray(response.errors))) throw new Error('Invalid worktree validation');
        if (response.ok === false) {
          for (const item of response.errors as unknown[]) {
            const error = record(item), code = text(error.code), detail = text(error.message);
            if (code === 'worktree_exists') result.folder ||= detail;
            else if (code.startsWith('branch_')) result.branch ||= detail;
            else result.request ||= detail;
          }
          if (!result.folder && !result.branch && !result.request) result.request = t('session.newWorktree.error.createWorktreeFailed');
        }
        if (valid()) errors.set(result);
      } catch (failure) { if (valid()) errors.set({ ...result, request: message(failure) }); }
      finally { validationFlight = false; if (valid()) validating.set(false); const next = queued; queued = undefined; next?.(); }
    };
    const timer = setTimeout(() => { void run(); }, 300);
    cleanup(() => { clearTimeout(timer); if (revision === serial) revision++; queued = undefined; });
  });
  function editBranch(value: string) { namesEdited = true; branch.set(value); folder.set(slugifyWorktreeName(value)); touched.set(true); }
  function editFolder(value: string) { namesEdited = true; if (mode() === 'new') folder.set(value); else existingFolder.set(value); touched.set(true); }
  function selectSource(value: string) { sourceRevision++; source.set(value); touched.set(true); }
  function selectExisting(value: string) { existingBranch.set(value); existingFolder.set(slugifyWorktreeName(value.replace(/^remotes\//, ''))); touched.set(true); }
  async function submit(create: () => Promise<string | undefined>) {
    if (!active() || !ready() || submitting()) return;
    const remembered = resolveWorktreeSourceBranchToPersist({ mode: mode() === 'new' ? 'new-branch' : 'existing-branch', sourceBranch: source(), selectedBranch: existingBranch(), linkedPr: false });
    const operation = options.capture(); revision++; queued = undefined; submitting.set(true); validating.set(false);
    try {
      const path = confirmedPath() || await create();
      if (!path || !active() || !operation.current()) return;
      confirmedPath.set(path);
      if (remembered) await Storage.setItem(memoryKey, remembered);
      if (active() && operation.current()) return path;
    } catch (failure) { if (active() && operation.current()) errors.set({ ...emptyErrors(), request: message(failure) }); }
    finally { if (active() && operation.current()) submitting.set(false); }
  }
  cleanup(() => { alive = false; revision++; contextRevision++; queued = undefined; });
  return { branch, folder, source, existingBranch, existingFolder, mode, branches, ready, contextError, contextLoading, errors, touched, validating, submitting, confirmedPath,
    selectedBranch, selectedFolder, reset, prepare, editBranch, editFolder, selectSource, selectExisting, submit, retryValidation: () => retry.set(retry() + 1) };
}
