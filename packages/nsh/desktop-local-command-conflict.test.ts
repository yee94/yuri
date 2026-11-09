import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeLocalCommandConflict, NativeLocalCommandSnapshot } from './composer-local-commands';

const alert = vi.hoisted(() => vi.fn());
vi.mock('nsh/base', () => ({ AlertDialog: { show: alert } }));
vi.mock('./i18n', () => ({ t: (key: string) => key }));
import { confirmNativeLocalCommandConflict } from './desktop-local-command-conflict';

function fixture(phase: 'selection' | 'submit' = 'submit', presetText?: string) {
  let revision = 1, text = '/new important tail', active = true;
  const snapshot: NativeLocalCommandSnapshot = { scope: { host: 'one', draft: 'draft', directory: '/repo' }, authority: 'operation-1', target: { kind: 'draft', id: 'draft', directory: '/repo' }, revision, text, inputMode: 'normal', active: true, ready: true, pending: false, unknown: false, sending: false, queueEditing: false, hasReferences: false, hasMessages: false, selection: {} };
  const conflict: NativeLocalCommandConflict = { kind: 'conflict', command: 'new', phase, webText: phase === 'submit' ? '' : '/new ', snapshot, ...(presetText === undefined ? {} : { presetText }) };
  const replace = vi.fn((expected: NativeLocalCommandSnapshot, value: string) => {
    if (expected !== snapshot || expected.revision !== revision || expected.text !== text || !active) return false;
    text = value; revision++; return true;
  }), submit = vi.fn(), focus = vi.fn();
  return { conflict, ports: { current: () => active, replace, submit, focus }, text: () => text,
    edit: (value: string) => { text = value; revision++; }, hide: () => { active = false; } };
}
beforeEach(() => { alert.mockReset().mockResolvedValue({ action: 'discard' }); });
describe('shared native local-command conflict confirmation', () => {
  it('uses the real native confirmation and generic translated loss warning, then delegates a bare command', async () => {
    const f = fixture(); const result = await confirmNativeLocalCommandConflict(f.conflict, f.ports);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: 'filesView.unsaved.title', description: 'sessions.scheduledTasks.workspace.confirm.discardChanges' }));
    expect(result).toEqual({ status: 'applied', submitted: true }); expect(f.text()).toBe('/new'); expect(f.ports.submit).toHaveBeenCalledOnce(); expect(f.ports.focus).toHaveBeenCalledOnce();
  });
  it('applies a selection preset before submit rather than creating the same tail conflict again', async () => {
    const f = fixture('selection', '/new'); await confirmNativeLocalCommandConflict(f.conflict, f.ports);
    expect(f.text()).toBe('/new'); expect(f.ports.submit).toHaveBeenCalledOnce();
  });
  it('inserts the exact webText without business submission when there is no preset', async () => {
    const f = fixture('selection'); expect(await confirmNativeLocalCommandConflict(f.conflict, f.ports)).toEqual({ status: 'applied', submitted: false });
    expect(f.text()).toBe('/new '); expect(f.ports.submit).not.toHaveBeenCalled();
  });
  it('Cancel preserves everything and restores focus only while still current', async () => {
    alert.mockResolvedValue({ action: 'cancel' }); const f = fixture();
    expect(await confirmNativeLocalCommandConflict(f.conflict, f.ports)).toEqual({ status: 'cancelled' });
    expect(f.text()).toBe('/new important tail'); expect(f.ports.replace).not.toHaveBeenCalled(); expect(f.ports.submit).not.toHaveBeenCalled(); expect(f.ports.focus).toHaveBeenCalledOnce();
  });
  it('an edit-away-and-back cannot pass the exact monotonic document CAS', async () => {
    const f = fixture(); alert.mockImplementation(async () => { f.edit('new user text'); f.edit('/new important tail'); return { action: 'discard' }; });
    expect(await confirmNativeLocalCommandConflict(f.conflict, f.ports)).toEqual({ status: 'stale' }); expect(f.ports.submit).not.toHaveBeenCalled(); expect(f.ports.focus).not.toHaveBeenCalled();
  });
  it('inactive or retired presentation never opens or applies a dialog/focus result', async () => {
    const f = fixture(); f.hide(); expect(await confirmNativeLocalCommandConflict(f.conflict, f.ports)).toEqual({ status: 'stale' }); expect(alert).not.toHaveBeenCalled();
    const other = fixture(); alert.mockImplementation(async () => { other.hide(); return { action: 'discard' }; });
    expect(await confirmNativeLocalCommandConflict(other.conflict, other.ports)).toEqual({ status: 'stale' }); expect(other.ports.replace).not.toHaveBeenCalled(); expect(other.ports.focus).not.toHaveBeenCalled();
  });
  it('never converts native dialog errors into document/action success', async () => {
    alert.mockRejectedValue(new Error('native failure')); const f = fixture();
    expect(await confirmNativeLocalCommandConflict(f.conflict, f.ports)).toEqual({ status: 'rejected' }); expect(f.ports.replace).not.toHaveBeenCalled(); expect(f.ports.submit).not.toHaveBeenCalled();
  });
});
