import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const source = ts.createSourceFile('App.tsx', readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect: string | undefined;
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'React.useEffect'
    && node.arguments[0]?.getText(source).includes("addEventListener('yuri:open-draft-session'")) effect = node.arguments[0].getText(source);
  ts.forEachChild(node, visit);
};
visit(source);

function mountNativeEffect(apply: (route: unknown, isCurrent: () => boolean) => Promise<boolean> = async () => true) {
  expect(effect).toBeDefined();
  const projects = [{ id: 'local', path: '/same/path' }, { id: 'remote', hostId: 'host', hubId: 'hub', path: '/same/path' }];
  const state = { projects, activeProjectId: 'remote', setActiveProjectIdOnly: vi.fn() };
  const navigation = { remoteSession: null as null | { location: { hubId: string; hostId: string; directory: string } },
    openRemoteSession: vi.fn(), clearRemoteSession: vi.fn() };
  const localDraft = vi.fn(); const seed = vi.fn(async () => {}); const error = vi.fn();
  const code = ts.transpileModule(`return (${effect})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const cleanup = new Function('useUIStore', 'useProjectsStore', 'useSessionNavigationStore', 'useSessionUIStore', 'applyRemoteProjectRoute', 'seedRemoteProjectDraft', 'toast', code)(
    { getState: () => ({ setActiveMainTab: vi.fn(), setSessionSwitcherOpen: vi.fn() }) }, { getState: () => state },
    { getState: () => navigation }, { getState: () => ({ openNewSessionDraft: localDraft }) }, apply, seed, { error },
  ) as () => void;
  return { state, navigation, localDraft, seed, error, cleanup };
}

it('the production native New event targets the selected remote draft and initial prompt instead of the retained Hub directory', async () => {
  const fixture = mountNativeEffect();
  try {
    window.dispatchEvent(new CustomEvent('yuri:open-draft-session', { detail: { initialPrompt: 'Start here' } }));
    await Promise.resolve();
    expect(fixture.navigation.openRemoteSession).toHaveBeenCalledWith(fixture.state.projects[1], { hubId: 'hub', hostId: 'host', directory: '/same/path' }, null);
    expect(fixture.seed).toHaveBeenCalledWith({ hubId: 'hub', hostId: 'host', directory: '/same/path' }, 'Start here');
    expect(fixture.localDraft).not.toHaveBeenCalled();
    expect(fixture.error).not.toHaveBeenCalled();
  } finally { fixture.cleanup(); }
});

it('an explicit local New event clears the remote bridge while preserving its original local draft contract', () => {
  const fixture = mountNativeEffect();
  try {
    window.dispatchEvent(new CustomEvent('yuri:open-draft-session', { detail: { projectId: 'local', directory: '/same/path', initialPrompt: 'Local' } }));
    expect(fixture.navigation.clearRemoteSession).toHaveBeenCalledOnce();
    expect(fixture.localDraft).toHaveBeenCalledWith({ selectedProjectId: 'local', directoryOverride: '/same/path', preserveDirectoryOverride: true, ensureProjectForDirectory: true, initialPrompt: 'Local' });
    expect(fixture.navigation.openRemoteSession).not.toHaveBeenCalled(); expect(fixture.seed).not.toHaveBeenCalled();
  } finally { fixture.cleanup(); }
});

it('a delayed explicit Host event cannot seed text into a different selection after navigation', async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  const apply = vi.fn(async (_route: unknown, isCurrent: () => boolean) => { await ready; return isCurrent(); });
  const fixture = mountNativeEffect(apply);
  try {
    window.dispatchEvent(new CustomEvent('yuri:open-draft-session', { detail: { hostId: 'host', hubId: 'hub', directory: '/same/path', initialPrompt: 'Old intent' } }));
    fixture.navigation.remoteSession = { location: { hubId: 'hub', hostId: 'another-host', directory: '/different' } };
    finish(); await ready; await Promise.resolve(); await Promise.resolve();
    expect(apply).toHaveBeenCalledOnce();
    expect(fixture.seed).not.toHaveBeenCalled(); expect(fixture.localDraft).not.toHaveBeenCalled();
  } finally { fixture.cleanup(); }
});
