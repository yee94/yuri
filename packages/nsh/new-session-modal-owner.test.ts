import { describe, expect, it } from 'vitest';
import { createNewSessionModalOwner } from './new-session-modal-owner';

describe('new-session modal lifecycle callbacks (pure, no NSH engine)', () => {
  it('waits for real Dialog open, then real Sheet close and Dialog dismissal before releasing a generation', () => {
    const owner = createNewSessionModalOwner<'agent' | 'model'>();
    owner.request('agent');
    const first = owner.current()!;
    expect(first.phase).toBe('native-opening');
    owner.dialogOpened(first.generation);
    expect(owner.current()?.phase).toBe('sheet-opening');
    owner.sheetOpened(first.generation);
    expect(owner.current()?.phase).toBe('open');
    expect(owner.close(first.generation)).toBe(true);
    expect(owner.current()).toMatchObject({ ...first, phase: 'sheet-closing' });
    owner.sheetClosed(first.generation);
    expect(owner.current()).toMatchObject({ ...first, phase: 'native-dismissing' });
    owner.request('model');
    expect(owner.current()?.generation).toBe(first.generation);
    expect(owner.dialogClosed(first.generation)).toBe('dismissed');
    expect(owner.current()).toMatchObject({ value: 'model', phase: 'native-opening', generation: first.generation + 1 });
  });
  it('serializes close/reopen before native onOpen without showing a cancelled Sheet or reusing its generation', () => {
    const owner = createNewSessionModalOwner<'agent'>(); owner.request('agent'); const first = owner.current()!.generation;
    owner.request(null); expect(owner.current()?.phase).toBe('native-opening-cancelled');
    owner.request('agent'); expect(owner.close(first)).toBe(false);
    owner.dialogOpened(first); expect(owner.current()?.phase).toBe('native-dismissing');
    owner.sheetOpened(first); expect(owner.current()?.phase).toBe('native-dismissing');
    owner.dialogClosed(first); expect(owner.current()).toMatchObject({ generation: first + 1, phase: 'native-opening' });
  });
  it('ignores every stale callback after a queued generation starts', () => {
    const owner = createNewSessionModalOwner<'agent' | 'model'>(); owner.request('agent'); const old = owner.current()!.generation;
    owner.dialogOpened(old); owner.sheetOpened(old); owner.close(old); owner.request('model'); owner.sheetClosed(old); owner.dialogClosed(old);
    const current = owner.current();
    owner.dialogOpened(old); owner.sheetOpened(old); owner.sheetClosed(old);
    expect(owner.close(old)).toBe(false); expect(owner.dialogClosed(old)).toBe('stale'); expect(owner.current()).toBe(current);
  });
  it('a cancelled native entrance can dismiss without onOpen without clearing the newer queued intent', () => {
    const owner = createNewSessionModalOwner<'agent' | 'model'>(); owner.request('agent'); const first = owner.current()!.generation;
    owner.request(null); owner.request('model');
    expect(owner.dialogClosed(first)).toBe('dismissed');
    expect(owner.current()).toMatchObject({ value: 'model', generation: first + 1, phase: 'native-opening' });
  });
  it('retains original content while closing; only the latest requested mode enters after native dismissal', () => {
    const owner = createNewSessionModalOwner<'agent' | 'model' | 'project'>(); owner.request('agent'); const id = owner.current()!.generation;
    owner.dialogOpened(id); owner.request('model'); owner.request('project');
    expect(owner.current()).toMatchObject({ value: 'agent', phase: 'sheet-opening-cancelled' }); expect(owner.interactive(id)).toBe(false);
    owner.sheetOpened(id); expect(owner.current()?.phase).toBe('sheet-closing');
    owner.sheetClosed(id); expect(owner.close(id)).toBe(false); owner.dialogClosed(id);
    expect(owner.current()).toMatchObject({ value: 'project', generation: id + 1, phase: 'native-opening' });
  });
  it('does not replay an interrupted native presentation or accept duplicate closes', () => {
    const owner = createNewSessionModalOwner<'agent'>(); owner.request('agent'); const id = owner.current()!.generation;
    owner.dialogOpened(id); expect(owner.dialogClosed(id)).toBe('interrupted'); expect(owner.current()).toBeNull();
    expect(owner.dialogClosed(id)).toBe('stale'); owner.sheetClosed(id); expect(owner.current()).toBeNull();
    owner.request('agent'); expect(owner.current()?.generation).toBe(id + 1);
  });
  it.each(['native-opening', 'sheet-opening', 'open', 'sheet-closing', 'native-dismissing'] as const)('cleanup during %s waits for native release and can never reopen', phase => {
    const owner = createNewSessionModalOwner<'agent'>(); owner.request('agent'); const id = owner.current()!.generation;
    if (phase !== 'native-opening') owner.dialogOpened(id);
    if (phase === 'open' || phase === 'sheet-closing' || phase === 'native-dismissing') owner.sheetOpened(id);
    if (phase === 'sheet-closing' || phase === 'native-dismissing') owner.close(id);
    if (phase === 'native-dismissing') owner.sheetClosed(id);
    expect(owner.current()?.phase).toBe(phase);
    owner.dispose(); owner.dispose(); expect(owner.current()).toMatchObject({ generation: id, phase: 'native-dismissing' });
    owner.request('agent'); owner.dialogOpened(id); owner.sheetOpened(id); expect(owner.interactive(id)).toBe(false);
    expect(owner.dialogClosed(id)).toBe('dismissed'); expect(owner.current()).toBeNull();
  });
  it('does no presentation work for repeated identical intent and does not release on Sheet close alone', () => {
    const changes: unknown[] = [], owner = createNewSessionModalOwner<'agent'>(state => changes.push(state));
    owner.request('agent'); const id = owner.current()!.generation, first = owner.current();
    for (let index = 0; index < 200; index++) owner.request('agent');
    expect(owner.current()).toBe(first); expect(changes).toHaveLength(1);
    owner.dialogOpened(id); owner.sheetOpened(id); expect(owner.close(id)).toBe(true); expect(owner.close(id)).toBe(false);
    owner.sheetClosed(id); expect(owner.current()?.generation).toBe(id);
  });
});
