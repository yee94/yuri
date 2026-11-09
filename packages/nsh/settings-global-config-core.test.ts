import { describe, expect, it, vi } from 'vitest';
import { createGlobalConfigEditor } from './settings-global-config-core';

const file = (content: string) => ({ target: 'opencode', fileName: 'opencode.jsonc', content });
const deferred = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; };
describe('native global config editor', () => {
  it('keeps JSONC verbatim and commits the exact acknowledged Host file without a second PUT', async () => {
    const request = vi.fn(async (_path: string, method?: string, body?: unknown) => method === 'PUT' ? file((body as { content: string }).content) : file('{\n// keep comment\n}\n'));
    const editor = createGlobalConfigEditor(request, () => true, () => {});
    await editor.load(); expect(editor.state().draft).toBe('{\n// keep comment\n}\n');
    const draft = '{\n// changed\n"lsp":true,\n}\n'; editor.edit(draft); expect(editor.dirty()).toBe(true);
    await editor.save(); expect(editor.state()).toMatchObject({ draft, saved: true, unconfirmed: false, busy: false }); expect(editor.dirty()).toBe(false);
    await editor.save();
    expect(request.mock.calls).toEqual([['/api/config/global/opencode'], ['/api/config/global/opencode', 'PUT', { content: draft }]]);
  });
  it('retains dirty text and the last good file on refresh failure or malformed data', async () => {
    const request = vi.fn().mockResolvedValue(file('{}'));
    const editor = createGlobalConfigEditor(request, () => true, () => {});
    await editor.load(); editor.edit('{"draft":true}');
    request.mockRejectedValueOnce(new Error('secret sentinel')); await editor.load();
    expect(editor.state()).toMatchObject({ draft: '{"draft":true}', file: file('{}'), error: 'load' });
    expect(JSON.stringify(editor.state())).not.toContain('sentinel');
    request.mockResolvedValueOnce({ target: 'other', fileName: 'wrong.json', content: '' }); await editor.load();
    expect(editor.dirty()).toBe(true); expect(editor.state().file).toEqual(file('{}'));
    request.mockResolvedValueOnce(file('{"remote":true}')); await editor.load();
    expect(editor.state().draft).toBe('{"draft":true}');
    await editor.load(true); expect(editor.state().draft).toBe('{}');
  });
  it('reconciles a lost ACK only by GET; a different authoritative file retains the draft for a separate explicit save', async () => {
    let content = '{}', fail = true;
    const request = vi.fn(async (_path: string, method?: string, body?: unknown) => {
      if (method === 'PUT') { content = (body as { content: string }).content; if (fail) throw new Error('lost ACK'); }
      return file(content);
    });
    const editor = createGlobalConfigEditor(request, () => true, () => {});
    await editor.load(); editor.edit('{"local":true}'); await editor.save();
    expect(editor.state()).toMatchObject({ busy: false, unconfirmed: true, error: 'save' }); expect(editor.dirty()).toBe(true);
    editor.edit('must not replace unresolved input');
    await editor.save(); expect(editor.state()).toMatchObject({ unconfirmed: false, saved: true });
    expect(request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
    editor.edit('{"next":true}'); await editor.save(); content = '{"other":true}';
    await editor.save(); expect(editor.state()).toMatchObject({ unconfirmed: false, draft: '{"next":true}', saved: false }); expect(editor.dirty()).toBe(true);
    expect(request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(2);
    fail = false; await editor.save(); expect(editor.dirty()).toBe(false);
  });
  it('fences retired Host responses, rejects background edits and serializes an in-flight save', async () => {
    const reply = deferred<unknown>(); let active = true;
    const request = vi.fn().mockResolvedValue(file('{}'));
    const editor = createGlobalConfigEditor(request, () => active, () => {});
    await editor.load(); editor.edit('new'); request.mockReturnValueOnce(reply.promise);
    const saving = editor.save(); await editor.save(); editor.edit('ignored');
    expect(editor.state().draft).toBe('new'); expect(request).toHaveBeenCalledTimes(2);
    active = false; editor.replaceLane(null); reply.resolve(file('new')); await saving;
    expect(editor.state()).toMatchObject({ draft: 'new', file: file('{}'), unconfirmed: true, busy: false });
    editor.edit('background'); expect(editor.state().draft).toBe('new');
    request.mockResolvedValue(file('new')); editor.replaceLane({ request, current: () => true }); await editor.load();
    expect(editor.state()).toMatchObject({ draft: 'new', unconfirmed: false, saved: true });
  });
});
