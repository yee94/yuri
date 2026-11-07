import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { nativeMagicDefaults } from './settings-magic-defaults';
import { createSettingsLaneOwner, createSettingsTransaction, settingsObject, type SettingsRequest, type SettingsRequestLane } from './settings-protocol';

export const magicPromptGroups = [
  { group: 'git', entries: [
    { id: 'git.commit.generate', label: 'gitCommitGenerate', section: 'gitCommitGenerate' },
    { id: 'git.pr.generate', label: 'gitPrGenerate', section: 'gitPrGenerate' },
    { id: 'git.conflict.resolve', label: 'gitConflictResolve', section: 'gitConflictResolve' },
    { id: 'git.integrate.cherrypick.resolve', label: 'gitCherrypickConflictResolve', section: 'gitCherrypickConflictResolve' },
  ] },
  { group: 'github', entries: [
    { id: 'github.pr.review', label: 'githubPrReview', section: 'githubPrReview' },
    { id: 'github.issue.review', label: 'githubIssueReview', section: 'githubIssueReview' },
    { id: 'github.pr.checks.review', label: 'githubPrFailedChecksReview', section: 'githubPrFailedChecksReview' },
    { id: 'github.pr.comments.review', label: 'githubPrCommentsReview', section: 'githubPrCommentsReview' },
    { id: 'github.pr.comment.single', label: 'githubSinglePrCommentReview', section: 'githubSinglePrCommentReview' },
  ] },
  { group: 'session', entries: [
    { id: 'session.explore', label: 'sessionExplore', section: 'sessionExplore' },
    { id: 'session.summary', label: 'sessionSummary', section: 'sessionSummary' },
    { id: 'session.review', label: 'sessionWorkspaceReview', section: 'sessionWorkspaceReview' },
    { id: 'session.craftGoal', label: 'sessionCraftGoal', section: 'sessionCraftGoal' },
    { id: 'session.catchup', label: 'sessionCatchUp', section: 'sessionCatchUp' },
    { id: 'session.debug', label: 'sessionDebug', section: 'sessionDebug' },
    { id: 'session.weigh', label: 'sessionWeigh', section: 'sessionWeigh' },
    { id: 'session.fusion', label: 'sessionFusion', section: 'sessionFusion' },
  ] },
] as const;
export type MagicPromptEntry = typeof magicPromptGroups[number]['entries'][number];

export type MagicPromptsSnapshot = {
  ready: boolean;
  busy: string | null;
  overrides: Record<string, string>;
  drafts: Record<string, string>;
  error: I18nKey | null;
  detail: string;
  notice: I18nKey | null;
};
export const emptyMagicPromptsSnapshot = (): MagicPromptsSnapshot => ({ ready: false, busy: null, overrides: {}, drafts: {}, error: null, detail: '', notice: null });
const owns = (value: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export function parseMagicOverrides(value: unknown): Record<string, string> {
  const body = settingsObject(value);
  if (body.version !== 1) throw new Error('Invalid magic prompts version');
  const raw = settingsObject(body.overrides);
  const overrides = Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  // Identical persisted compatibility to the Web editor: split the two legacy combined prompts.
  for (const id of ['git.commit.generate', 'git.pr.generate']) {
    const legacy = overrides[id];
    if (typeof legacy !== 'string') continue;
    const newline = legacy.indexOf('\n');
    const visible = (newline === -1 ? legacy : legacy.slice(0, newline)).trim();
    const instructions = newline === -1 ? '' : legacy.slice(newline + 1).trim();
    if (!owns(overrides, id + '.visible') && visible) overrides[id + '.visible'] = visible;
    if (!owns(overrides, id + '.instructions') && instructions) overrides[id + '.instructions'] = instructions;
  }
  return overrides;
}

export function createMagicPromptsEditor(send: SettingsRequest, current: () => boolean, changed: (snapshot: MagicPromptsSnapshot) => void) {
  let snapshot = emptyMagicPromptsSnapshot();
  const transport = createSettingsLaneOwner(send, current);
  let pending: { id: string; expected: string | null; kind: 'save' | 'reset' | 'all'; edits: Map<string, number> } | null = null;
  const draftEdits = new Map<string, number>();
  let recovered = false;
  const publish = (patch: Partial<MagicPromptsSnapshot>, lane = transport.capture()) => { if (!lane?.current()) return; snapshot = { ...snapshot, ...patch }; changed(snapshot); };
  const baseline = (id: string) => owns(snapshot.overrides, id) ? snapshot.overrides[id] : nativeMagicDefaults[id];
  const value = (id: string) => owns(snapshot.drafts, id) ? snapshot.drafts[id] : baseline(id);
  async function operation(id: string, failed: I18nKey, work: (lane: SettingsRequestLane) => Promise<void>) {
    const lane = transport.capture();
    if (snapshot.busy || !lane?.current()) return;
    publish({ busy: id, error: null, detail: '', notice: null }, lane);
    try { await work(lane); }
    catch (error) { publish({ error: failed, detail: error instanceof Error ? error.message : '' }, lane); }
    finally { publish({ busy: null }, lane); }
  }
  async function read(lane: SettingsRequestLane) {
    const overrides = parseMagicOverrides(await lane.request('/api/magic-prompts'));
    if (!lane.current()) return;
    let drafts = snapshot.drafts;
    if (pending && (pending.id === 'all' ? !Object.keys(overrides).length : pending.expected === null ? !owns(overrides, pending.id) : overrides[pending.id] === pending.expected)) {
      const transaction = pending;
      if (transaction.kind === 'reset' && draftEdits.get(transaction.id) === transaction.edits.get(transaction.id)) drafts = { ...drafts, [transaction.id]: nativeMagicDefaults[transaction.id] };
      if (transaction.kind === 'all') drafts = Object.fromEntries(Object.entries(drafts).filter(([id]) => draftEdits.get(id) !== transaction.edits.get(id)));
      pending = null;
    }
    publish({ overrides, drafts, ready: true }, lane);
  }
  function known(id: string) { return Object.prototype.hasOwnProperty.call(nativeMagicDefaults, id); }
  return {
    snapshot: () => snapshot,
    replaceLane(next: SettingsRequestLane | null) { transport.replaceLane(next); recovered = true; snapshot = { ...snapshot, busy: null }; changed(snapshot); },
    value,
    baseline,
    dirty: (id: string) => value(id) !== baseline(id),
    overridden: (id: string) => owns(snapshot.overrides, id),
    setDraft(id: string, text: string) {
      if (!known(id) || snapshot.busy || !transport.capture()?.current()) return;
      draftEdits.set(id, (draftEdits.get(id) ?? 0) + 1);
      publish({ drafts: { ...snapshot.drafts, [id]: text }, error: null, detail: '', notice: null });
    },
    async load() {
      await operation('load', 'settings.magicPrompts.page.toast.loadFailed', read);
    },
    async save(id: string) {
      if (!snapshot.ready || !known(id) || snapshot.busy || !transport.capture()?.current()) return;
      const text = value(id);
      if (id.endsWith('.visible') && !text.trim()) {
        publish({ error: 'settings.magicPrompts.page.toast.visiblePromptRequired', detail: '' }); return;
      }
      await operation(id, 'settings.magicPrompts.page.toast.saveFailed', async lane => {
        if (pending && recovered) { await read(lane); return; }
        const transaction = createSettingsTransaction(lane.request, lane.current);
        const reset = text === nativeMagicDefaults[id];
        pending = { id, expected: reset ? null : text, kind: 'save', edits: new Map(draftEdits) };
        const result = await transaction(`/api/magic-prompts/${encodeURIComponent(id)}`, reset ? 'DELETE' : 'PUT', reset ? undefined : { text });
        const overrides = parseMagicOverrides(result);
        if (!lane.current()) return;
        pending = null; publish({ overrides, notice: 'settings.magicPrompts.page.toast.saved' }, lane);
      });
    },
    async reset(id: string) {
      if (!snapshot.ready || !known(id)) return;
      await operation(id, 'settings.magicPrompts.page.toast.resetFailed', async lane => {
        if (pending && recovered) { await read(lane); return; }
        const transaction = createSettingsTransaction(lane.request, lane.current);
        pending = { id, expected: null, kind: 'reset', edits: new Map(draftEdits) };
        const overrides = parseMagicOverrides(await transaction(`/api/magic-prompts/${encodeURIComponent(id)}`, 'DELETE'));
        if (!lane.current()) return;
        pending = null; publish({ overrides, drafts: { ...snapshot.drafts, [id]: nativeMagicDefaults[id] }, notice: 'settings.magicPrompts.page.toast.resetSuccess' }, lane);
      });
    },
    async resetAll() {
      if (!snapshot.ready) return;
      await operation('all', 'settings.magicPrompts.page.toast.resetAllFailed', async lane => {
        if (pending && recovered) { await read(lane); return; }
        const transaction = createSettingsTransaction(lane.request, lane.current);
        pending = { id: 'all', expected: null, kind: 'all', edits: new Map(draftEdits) };
        const overrides = parseMagicOverrides(await transaction('/api/magic-prompts', 'DELETE'));
        if (!lane.current()) return;
        pending = null; publish({ overrides, drafts: {}, notice: 'settings.magicPrompts.page.toast.resetAllSuccess' }, lane);
      });
    },
  };
}
