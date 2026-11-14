import { cleanup, computed, host, lifecycle, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { createChangesReader, type ChangesSnapshot, type ChangesSource } from './chat-changes-model';
import { NativeDesktopDiffList } from './desktop-diff-list';
import type { DesktopDiffScope } from './desktop-diff-list-core';
import type { DesktopDiffPreferences } from './desktop-diff-model';
import { bindRequest } from './runtime';
import { language } from './i18n';

/** Synthetic exact catalogs, original reader and production list/documents.
 * Scope changes swap exact turn source; working/staged retain the same reader. */
function Fixture() {
  language.set('en');
  const scope = signal<DesktopDiffScope>(host.params.history ? 'turn' : 'working'), active = signal(true), current = signal(true), draft = signal(''), revision = signal(0);
  const preferences = signal<DesktopDiffPreferences>({ layoutPreference: 'dynamic', wrapLines: false });
  const target = signal<string | undefined>(undefined), control = signal(''), refreshRevision = signal(0);
  let readers = 0, disposed = 0;
  let visible: readonly string[] = [];
  const demand: { path: string; visible: boolean; current: boolean }[] = [];
  const directory = '/workspace';
  const count = host.params.one ? 1 : host.params.many ? 40 : 3;
  const snapshot: ChangesSnapshot = { isClean: false, files: Array.from({ length: count }, (_, index) => ({ path: index === 0 ? 'z.ts' : index === 1 ? 'a.ts' : 'file-' + index + '.ts', index: host.params.full || index === 1 ? ' ' : 'M', working_dir: 'M' })) };
  const workspace: ChangesSource = { kind: 'workspace', directory };
  const lines = Number(host.params.lines ?? 40);
  const history: ChangesSource = { kind: 'turn', directory: '/historical', sessionID: 'child', messageID: 'user-exact', files: [
    { path: 'z.ts', before: 'OLD_HISTORY\n'.repeat(lines) + 'OLD_END', after: 'NEW_HISTORY\n'.repeat(lines) + 'NEW_END' },
    { path: 'a.ts', before: 'A_BEFORE', after: 'A_AFTER' },
    { path: 'thin.ts' },
  ], loadFile: async () => { throw new Error('exact historical resolver unavailable'); } };
  if (host.params.recycle) history.files = [{ path: 'z.ts', before: 'OLD_RECYCLE_TOP\n' + 'OLD_HISTORY\n'.repeat(lines - 1) + 'OLD_END', after: 'NEW_RECYCLE_TOP\n' + 'NEW_HISTORY\n'.repeat(lines - 1) + 'NEW_END' }, ...Array.from({ length: 239 }, (_, index) => ({ path: 'recycle-' + index + '.ts', before: 'BEFORE_' + index, after: 'AFTER_' + index }))];
  if (host.params.single) history.files = history.files.slice(0, 1);
  const source = computed(() => scope() === 'turn' ? history : workspace);
  const off = host.on<{ action: string; path?: string }>('diff.list.control', event => {
    if (event.action === 'active') active.set(!active());
    if (event.action === 'retire') current.set(false);
    if (event.action === 'target') target.set(event.path);
    if (event.action === 'refresh') refreshRevision.set(refreshRevision() + 1);
    if (event.action === 'scope-working') scope.set('working');
    if (event.action === 'scope-staged') scope.set('staged');
    if (event.action === 'scope-turn') scope.set('turn');
    if (event.action === 'audit') control.set(JSON.stringify({ readers, disposed, scope: scope(), directory: source().directory, demand }));
  });
  cleanup(off);
  return <View class="flex-1">
    <Input testID="diff-list-composer" value={draft()} onChange={event => draft.set(event.value)} />
    <Text testID="diff-list-audit">{control()}</Text>
    <Each of={[source()]} key={source => source}>{captured => {
      const own = captured(); readers++;
      const enabled = () => active() && current() && source() === own && lifecycle() === 'active';
      const request = bindRequest({ hostID: 'synthetic', lease: 'lease-a' });
      const reader = createChangesReader(own, path => {
        if (host.params.many) {
          const url = new URL(path, 'https://fixture.invalid');
          if (url.pathname === '/api/git/diff') demand.push({ path, visible: visible.includes(JSON.stringify([url.searchParams.get('staged') === 'true' ? 'staged' : 'working', url.searchParams.get('path')])), current: enabled() });
        }
        return request(path);
      }, enabled, () => revision.set(revision() + 1));
      cleanup(() => { disposed++; reader.cancel(); });
      return <NativeDesktopDiffList reader={reader} source={own} scope={scope()} snapshot={own.kind === 'workspace' ? snapshot : undefined} refreshRevision={refreshRevision()} active={active()} current={enabled}
        turnIsToolSnapshot={host.params.toolSnapshot === true} targetPath={target() ?? (own.kind === 'turn' ? 'z.ts' : undefined)} targetLine={own.kind === 'turn' ? 1 : undefined}
        showFileSidebar scopeChoices={[{ scope: 'working', available: true, count }, { scope: 'staged', available: true, count: count - 1 }, { scope: 'turn', available: true, count: history.files.length }]}
        onVisibleFilesChange={keys => { visible = keys; }}
        onScopeChange={value => scope.set(value)} preferences={preferences()} onLayoutChange={(_paths, layout) => preferences.set({ ...preferences(), layoutPreference: layout })} onWrapLinesChange={wrap => preferences.set({ ...preferences(), wrapLines: wrap })}
        onOpenFile={() => {}} />;
    }}</Each>
  </View>;
}
mount(Fixture);
