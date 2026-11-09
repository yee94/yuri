import { host, lifecycle, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { NativeDesktopChanges } from './desktop-panel-changes';
import { DesktopDiffDocument } from './desktop-diff-document';
import { nativeCodeFontSize } from './appearance';
import { language } from './i18n';
import type { ChangesSource, HistoricalChange } from './chat-changes-model';
import type { DesktopDiffPreferences } from './desktop-diff-model';

// Independent synthetic fixture; production components, no App/root or real Host.
function Fixture() {
  language.set('en');
  const active = signal(true), current = signal(true), draft = signal('Keep main draft');
  const preferences = signal<DesktopDiffPreferences>({ layoutPreference: 'dynamic', wrapLines: false });
  const path = 'source.ts', directory = host.params.windowsRoot ? 'C:\\repo' : '/repo';
  const mode = String(host.params.mode ?? 'history');
  const full: HistoricalChange = { path, patch: '', before: 'SAME\nBEFORE_EXACT\n' + 'retained context\n'.repeat(30) + 'OLD_TAIL', after: 'SAME\nAFTER_EXACT\n' + 'retained context\n'.repeat(30) + 'NEW_TAIL' };
  const large: HistoricalChange = { path, before: 'OLD_LARGE\n'.repeat(8000) + 'OLD_END', after: 'NEW_LARGE\n'.repeat(8000) + 'NEW_END' };
  const files = mode === 'large' ? [large] : mode === 'empty' ? [{ path, before: '', after: '' }] : mode === 'binary' ? [{ path, isBinary: true }] : [full, { path: 'second.ts', before: 'SECOND_OLD', after: 'SECOND_NEW' }];
  const source: ChangesSource = mode.startsWith('workspace') ? { kind: 'workspace', directory, path, staged: host.params.staged === true, ...(mode === 'workspace-full' ? { targetLine: 101 } : {}) } : { kind: 'turn', directory, sessionID: 'child', messageID: 'historical-user', files, path, targetLine: mode === 'large' ? 7999 : 2 };
  host.on<Record<string, unknown>>('desktop.diff.control', event => {
    if (event.action === 'active') active.set(event.value === true);
    if (event.action === 'retire') current.set(false);
    if (event.action === 'scale') nativeCodeFontSize.set(Number(event.value));
    if (event.action === 'preferences') preferences.set(event.value as DesktopDiffPreferences);
  });
  const onOpenFile = (path: string, line?: number) => host.post('desktop.diff.audit', { kind: 'preview', path, line });
  const onOpenEditor = (path: string, line: number) => host.post('desktop.diff.audit', { kind: 'editor', path, line });
  const onLayoutChange = (_paths: readonly string[], layout: 'inline' | 'side-by-side') => { host.post('desktop.diff.audit', { kind: 'layout', layout }); preferences.set({ ...preferences(), fileLayout: layout }); };
  const onWrapLinesChange = (wrapLines: boolean) => { host.post('desktop.diff.audit', { kind: 'wrap', wrapLines }); preferences.set({ ...preferences(), wrapLines }); };
  const onFocusStatus = (value: unknown) => host.post('desktop.diff.audit', { kind: 'focus', value });
  return <View class="flex-1">
    <Input testID="diff-fixture-composer" value={draft()} onChange={event => draft.set(event.value)} />
    <If when={mode === 'full-document'}><DesktopDiffDocument diff={full} current={() => current() && active() && lifecycle() === 'active'} historical={false} targetLine={2} preferences={preferences()} onLayoutChange={layout => onLayoutChange([path], layout)} onWrapLinesChange={onWrapLinesChange} onOpenFile={line => onOpenFile(path, line)} onOpenEditor={line => onOpenEditor(path, line)} onFocusStatus={onFocusStatus} /></If>
    <If when={mode !== 'full-document'}><NativeDesktopChanges source={source} scope={{ host: { hostID: 'synthetic-A', lease: 'lease-A' }, authorityKey: 'synthetic-authority-A', directory, sessionID: 'parent' }} current={current} active={active()} showFileSidebar={mode !== 'single-file'} singleFileView={mode === 'single-file'}
      files={source.kind === 'workspace' ? [{ path, staged: source.staged === true, status: 'M' }] : undefined}
      preferences={preferences()} onLayoutChange={onLayoutChange} onWrapLinesChange={onWrapLinesChange} onOpenFile={onOpenFile} onOpenEditor={onOpenEditor} onFocusStatus={onFocusStatus}
      onOpenDiff={value => host.post('desktop.diff.audit', { kind: 'file', path: value.path, source: value.kind, sessionID: value.kind === 'turn' ? value.sessionID : null, directory: value.directory })} /></If>
    <Text>diff-fixture-ready</Text>
  </View>;
}
mount(Fixture);
