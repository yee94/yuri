import { describe, expect, it } from 'vitest';
import { nativeMultiFileEntries, nativeToolDescription, nativeToolDetails, nativeToolDuration } from './transcript-tools-model';
import { toolIconSpec } from '../ui/src/components/chat/message/parts/toolIconModel';
import { createChangesReader, type ChangesSource } from './chat-changes-model';
import { nativeDiffIsNew, nativeDiffLayout } from './chat-changes-layout';

describe('production native tool projection', () => {
  it('formats authoritative F16 timing without inventing completed elapsed time', () => {
    expect(nativeToolDuration(1000, 12400)).toBe('11.4s');
    expect(nativeToolDuration(1000, 107000)).toBe('1m 46s');
    expect(nativeToolDuration(1000, 1000)).toBe('0.1s');
    expect(nativeToolDuration(1000, undefined)).toBe('');
    expect(nativeToolDuration(1000, undefined, 2400)).toBe('1.4s');
  });
  it('reads OpenCode 2 content leaves and top-level ran/completed clocks, not fixture-only output/time fields', () => {
    const value = nativeToolDetails({ type: 'tool', id: 'neutral-call', name: 'shell', time: { ran: 1000, completed: 12400 }, state: { status: 'completed', input: { command: 'printf neutral' }, output: 'stale legacy output', content: [{ type: 'text', text: 'neutral' }, { type: 'image', data: 'not-text' }, { type: 'text', text: 'second leaf' }] } });
    expect(value).toMatchObject({ name: 'shell', command: 'printf neutral', output: 'neutral\nsecond leaf', start: 1000, end: 12400 });
    expect(nativeToolDuration(value.start, value.end)).toBe('11.4s');
  });
  it('takes child identity from live metadata, never a title containing an ID', () => {
    const details = nativeToolDetails({ tool: 'functions.task:2', metadata: { sessionID: 'old' }, state: { status: 'completed', title: 'ses_misleading', metadata: { sessionID: 'authoritative', subagent_type: 'explore', summary: [{ tool: 'read', state: { status: 'completed', title: 'Read file' } }] }, input: { sessionID: 'input-fallback' }, output: 'Result\n<task_metadata>{"sessionID":"output-fallback"}</task_metadata>' } });
    expect(details).toMatchObject({ name: 'task', sessionID: 'authoritative', agent: 'explore', output: 'Result', summary: [{ tool: 'read', state: { status: 'completed', title: 'Read file' } }] });
    expect(nativeToolDetails({ tool: 'task', state: { title: 'sessionID: imagined', input: { description: 'ses_fake' } } }).sessionID).toBeUndefined();
    expect(nativeToolDetails({ tool: 'read', state: { metadata: { sessionID: 'not-a-task' } } }).sessionID).toBeUndefined();
  });
  it('shares Web subagent aliases and explicit output metadata fallback', () => {
    expect(nativeToolDetails({ tool: 'subagent', state: { input: { subagent_type: 'reviewer' }, output: 'Done\n<task_metadata>{"sessionId":"child"}</task_metadata>' } })).toMatchObject({ sessionID: 'child', agent: 'reviewer', output: 'Done' });
  });
  it('preserves shell input, incomplete streaming input, errors, and output as text leaves', () => {
    const shell = nativeToolDetails({ tool: 'bash', state: { status: 'error', input: { command: 'pwd', options: { cwd: '/workspace' }, flags: ['a', 'b'] }, output: 'neutral output', error: { message: 'neutral error' } } });
    expect(shell).toMatchObject({ command: 'pwd', output: 'neutral output', error: 'neutral error' });
    expect(shell.fields).toEqual([{ key: 'command', value: 'pwd' }, { key: 'options.cwd', value: '/workspace' }, { key: 'flags[0]', value: 'a' }, { key: 'flags[1]', value: 'b' }]);
    expect(nativeToolDetails({ tool: 'custom', state: { input: '{"partial":' } }).streamingInput).toBe('{"partial":');
  });
  it('retains historical patches and rename destinations without querying current Git state', () => {
    const tool = nativeToolDetails({ tool: 'apply_patch', state: { metadata: { files: [{ filePath: 'old.txt', movePath: 'new.txt', diff: { patch: '@@ historical' }, before: 'old', after: 'new', additions: 1, deletions: 1 }] } } });
    expect(tool.files).toEqual([{ path: 'new.txt', patch: '@@ historical', before: 'old', after: 'new', additions: 1, deletions: 1 }]);
    expect(nativeToolDetails({ tool: 'edit', state: { input: { filePath: 'a', oldString: 'old', newString: 'new' } } }).files).toEqual([{ path: 'a', patch: '', before: 'old', after: 'new' }]);
    expect(nativeToolDetails({ tool: 'edit', state: { input: { filePath: 'stale' }, metadata: { filediff: { file: 'authoritative.txt', before: 'full old', after: 'full new', patch: '@@ file diff', additions: 1, deletions: 1 } } } }).files).toEqual([{ path: 'authoritative.txt', patch: '@@ file diff', before: 'full old', after: 'full new', additions: 1, deletions: 1 }]);
  });
  describe.each(['files', 'filediff'] as const)('%s metadata status through real historical Changes', branch => {
    const tool = (status: unknown, complete = true) => ({ name: branch === 'files' ? 'apply_patch' : 'write', state: { status: 'completed', input: { filePath: 'a.ts' }, metadata: branch === 'files'
      ? { files: [{ filePath: 'a.ts', status, ...(complete ? { before: '' } : {}), after: 'historical new text' }] }
      : { filediff: { file: 'a.ts', status, ...(complete ? { before: '' } : {}), after: 'historical new text' } } } });
    it.each(['added', 'modified', 'deleted', 'renamed'] as const)('retains validated %s without fetching or guessing from the empty before side', async status => {
      const files = nativeToolDetails(tool(status)).files;
      expect(files[0]).toMatchObject({ path: 'a.ts', status, before: '', after: 'historical new text' });
      expect(files[0].patch).toBe('');
      const calls: string[] = [], source: ChangesSource = { kind: 'turn', directory: '/fixture', sessionID: 'original', messageID: 'turn', files };
      const reader = createChangesReader(source, async path => { calls.push(path); throw new Error('Complete historical metadata must not fetch'); });
      await reader.select('a.ts');
      expect(reader.state().diffError).toBe(''); expect(reader.state().diff).toMatchObject({ path: 'a.ts', status, before: '', after: 'historical new text' });
      const isNew = nativeDiffIsNew(source, null, 'a.ts', reader.state().diff);
      expect(isNew).toBe(status === 'added'); expect(nativeDiffLayout('dynamic', 1600, isNew)).toBe(status === 'added' ? 'unified' : 'split');
      expect(calls).toEqual([]);
    });
    it.each([undefined, null, '', 'ADDED', 'completed', true, 1, {}])('omits invalid status %j rather than treating an empty before side as added', async status => {
      const files = nativeToolDetails(tool(status)).files; expect(files[0]).not.toHaveProperty('status');
      const source: ChangesSource = { kind: 'turn', directory: '/fixture', sessionID: 'original', messageID: 'turn', files };
      const reader = createChangesReader(source, async () => { throw new Error('Complete history must not fetch'); }); await reader.select('a.ts');
      expect(reader.state().diffError).toBe(''); expect(nativeDiffIsNew(source, null, 'a.ts', reader.state().diff)).toBe(false);
    });
    it('does not let added metadata turn one-sided history into body authority or fall back to current Git', async () => {
      const files = nativeToolDetails(tool('added', false)).files, calls: string[] = [];
      const reader = createChangesReader({ kind: 'turn', directory: '/fixture', sessionID: 'original', messageID: 'turn', files }, async path => { calls.push(path); return { diff: { file: 'a.ts', status: 'added', after: 'still only one side' } }; });
      await reader.select('a.ts');
      expect(reader.state().diff).toBeNull(); expect(reader.state().diffError).toBe('Historical diff body unavailable');
      expect(calls).toEqual(['/api/yuri/sessions/original/changes?directory=%2Ffixture&messageID=turn&file=a.ts']);
    });
  });
  it('projects todo rows instead of dumping the tool object', () => {
    expect(nativeToolDetails({ tool: 'todowrite', state: { input: { todos: [{ content: 'Verify', status: 'in_progress' }] } } }).todos).toEqual([{ content: 'Verify', status: 'in_progress' }]);
  });
  it('uses the Web artwork choices, native sizes and tool-specific description without changing navigation paths', () => {
    for (const [name, icon, size] of [['edit', 'pencil', 13], ['write', 'file-edit', 13], ['read', 'file-text', 14], ['shell', 'terminal-box', 14], ['grep', 'menu-search', 14], ['glob', 'file-search', 14], ['skill', 'book', 14], ['task', 'ai-agent', 14], ['webfetch', 'global', 14], ['lsp', 'scan-2', 14], ['unknown-plugin', 'tools', 14]] as const) expect(toolIconSpec(name)).toMatchObject({ name: icon, size });
    const edit = nativeToolDetails({ name: 'functions.patch', state: { metadata: { files: [{ filePath: '/fixture/a.ts', additions: 2, deletions: 1 }] } } });
    expect(edit.name).toBe('apply_patch');
    expect(nativeToolDescription(edit, '/fixture')).toBe('a.ts');
    expect(edit.files[0].path).toBe('/fixture/a.ts');
    expect(nativeToolDescription(nativeToolDetails({ name: 'shell', state: { title: 'Do not replace command', input: { command: 'first\nsecond' } } }), '/fixture')).toBe('first');
    expect(nativeToolDescription(nativeToolDetails({ name: 'task', state: { input: { description: 'x'.repeat(120) } } }), '')).toHaveLength(80);
    expect(nativeToolDescription(nativeToolDetails({ name: 'read', state: { input: { filePath: '/fixtures/keep.ts' } } }), '/fixture')).toBe('/fixtures/keep.ts');
  });
  it('shows each multi-file patch basename with its own counts and keeps single-file totals on the row', () => {
    const patch = nativeToolDetails({ name: 'apply_patch', state: { metadata: { files: [
      { relativePath: 'packages/nsh/ios/main.swift', additions: 4, deletions: 0 },
      { filePath: 'packages/nsh/nsh.json', additions: '8', deletions: 0 },
      { relativePath: 'packages/nsh/ios/main.swift', additions: 1.9 },
    ] } } });
    expect(nativeMultiFileEntries(patch)).toEqual([
      { path: 'packages/nsh/ios/main.swift', name: 'main.swift', added: 5, removed: 0 },
      { path: 'packages/nsh/nsh.json', name: 'nsh.json', added: null, removed: 0 },
    ]);
    expect(nativeToolDescription(patch, '/workspace')).toBe('');
    expect(patch.files.map(file => file.path)).toEqual(['packages/nsh/ios/main.swift', 'packages/nsh/nsh.json', 'packages/nsh/ios/main.swift']);
    expect(nativeMultiFileEntries(nativeToolDetails({ name: 'apply_patch', state: { metadata: { files: [{ relativePath: 'packages/nsh/ios/main.swift', additions: 12 }] } } }))).toEqual([]);
    expect(nativeMultiFileEntries(nativeToolDetails({ name: 'edit', state: { metadata: { files: [{ filePath: 'a.ts', additions: 1 }, { filePath: 'b.ts', deletions: 2 }] } } }))).toEqual([]);
  });
});
