import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitDesktopPanelContent, desktopPanelContentRequest, renderDesktopPanelContent, type DesktopPanelContentRequest, type DesktopPanelRendererContext, type DesktopPanelRendererSlots } from './desktop-panel-tabs-renderers';
const context: DesktopPanelRendererContext = { tabID: 'exact-tab', scope: { host: { hostID: 'synthetic', lease: 'lease' }, authorityKey: 'auth', sessionID: 'session-a', directory: '/workspace' }, active: () => true, current: () => true };
const source = { kind: 'workspace' as const, directory: '/workspace', path: 'a.ts', staged: true };
const requests: DesktopPanelContentRequest[] = [
  { kind: 'diff', source }, { kind: 'file-diff', source }, { kind: 'file', path: 'a.ts', targetLine: 12 }, { kind: 'context' },
  { kind: 'chat', sessionID: 'child-session', directory: '/other-workspace', readOnly: true, titleFallback: 'Synthetic child' },
  { kind: 'preview', target: { kind: 'html', path: 'index.html' } }, { kind: 'browser', url: 'https://example.invalid/' }, { kind: 'btw', sessionID: 'session-a' },
];
describe('authoritative eight-kind content ports, never placeholder tabs', () => {
  it('keeps the declared slot vocabulary equal to the current authoritative Web store union', () => {
    const store = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../ui/src/stores/useUIStore.ts'), 'utf8');
    const union = store.match(/export type ContextPanelMode\s*=\s*([^;]+);/)?.[1]; expect(union).toBeDefined();
    expect([...union!.matchAll(/'([^']+)'/g)].map(value => value[1]).sort()).toEqual(requests.map(request => request.kind).sort());
  });
  it('has exactly the real eight Web kinds and forwards each exact request/context to its registered renderer', () => {
    const called: string[] = [];
    const slots: DesktopPanelRendererSlots<string> = {};
    for (const request of requests) Object.assign(slots, { [request.kind]: (value: DesktopPanelContentRequest, owner: DesktopPanelRendererContext) => { expect(value).toBe(request); expect(owner).toBe(context); called.push(value.kind); return value.kind; } });
    for (const request of requests) expect(renderDesktopPanelContent(slots, request, context)).toBe(request.kind);
    expect(called).toEqual(['diff', 'file-diff', 'file', 'context', 'chat', 'preview', 'browser', 'btw']);
  });
  it('requires an actual slot before committing an intent; missing kinds never mutate the one model or render empty fallback', () => {
    const commit = vi.fn(() => true);
    for (const request of requests) {
      expect(admitDesktopPanelContent({}, request, context, commit)).toBe(false);
      expect(() => renderDesktopPanelContent({}, request, context)).toThrow('desktop_panel_renderer_unavailable');
    }
    expect(commit).not.toHaveBeenCalled();
    expect(admitDesktopPanelContent({ chat: () => 'real callback' }, requests[4], context, commit)).toBe(true); expect(commit).toHaveBeenCalledWith(requests[4]);
  });
  it('keeps readonly child Chat and BTW owning session distinct, validates paths and never relabels invalid content as current Git', () => {
    const commit = vi.fn(() => true), slots: DesktopPanelRendererSlots<string> = { 'file-diff': () => 'real diff', btw: () => 'real btw', chat: () => 'real child' };
    expect(() => admitDesktopPanelContent(slots, { kind: 'btw', sessionID: 'other' }, context, commit)).toThrow('desktop_panel_content_session_mismatch');
    expect(() => admitDesktopPanelContent(slots, { kind: 'file-diff', source: { ...source, path: '../outside' } }, context, commit)).toThrow();
    expect(admitDesktopPanelContent(slots, requests[4], { ...context, active: () => false }, commit)).toBe(false);
    expect(admitDesktopPanelContent(slots, requests[4], { ...context, current: () => false }, commit)).toBe(false); expect(commit).not.toHaveBeenCalled();
  });
  it('adapts existing native HTML as HTML, not Web arbitrary URL; all other live sources retain identity without copied content/state', () => {
    expect(desktopPanelContentRequest({ id: 'html', kind: 'preview', path: '/workspace/index.html' })).toEqual({ kind: 'preview', target: { kind: 'html', path: '/workspace/index.html' } });
    const diff = { id: 'diff', kind: 'diff' as const, source }; expect(desktopPanelContentRequest(diff)).toBe(diff);
  });
  it('maps the explicit readOnly target including its own directory and navigation request, never a tab-provided writable flag or parent session', () => {
    const tab = { id: 'exact-chat-tab', kind: 'chat' as const, target: { sessionID: 'child-session', directory: '/other-workspace', title: 'Synthetic child', messageID: 'exact-message' }, readOnly: false };
    const request = desktopPanelContentRequest(tab);
    expect(request).toEqual({ kind: 'chat', sessionID: 'child-session', directory: '/other-workspace', readOnly: true, titleFallback: 'Synthetic child', messageID: 'exact-message' });
    const renderer = vi.fn(() => 'real readOnly source');
    expect(renderDesktopPanelContent({ chat: renderer }, request, context)).toBe('real readOnly source');
    expect(renderer).toHaveBeenCalledExactlyOnceWith(request, context);
    expect(desktopPanelContentRequest({ id: 'bare-chat', kind: 'chat', target: { sessionID: 'child-session', directory: '/other-workspace' } })).toEqual({ kind: 'chat', sessionID: 'child-session', directory: '/other-workspace', readOnly: true });
  });
  it('rejects writable or incomplete untyped chat requests before commit/render; no directory/session/assistant inference', () => {
    const request = { kind: 'chat' as const, sessionID: 'child-session', directory: '/other-workspace', readOnly: true as const };
    const commit = vi.fn(() => true), renderer = vi.fn(() => 'real source');
    for (const patch of [{ readOnly: false }, { readOnly: undefined }, { directory: undefined }, { directory: '' }, { sessionID: undefined, assistantID: 'assistant-only' }]) {
      const malformed = { ...request, ...patch } as unknown as DesktopPanelContentRequest;
      expect(() => admitDesktopPanelContent({ chat: renderer }, malformed, context, commit)).toThrow();
      expect(() => renderDesktopPanelContent({ chat: renderer }, malformed, context)).toThrow();
    }
    expect(commit).not.toHaveBeenCalled(); expect(renderer).not.toHaveBeenCalled();
  });
  it('admits an exact child historical file snapshot in its own directory without widening workspace or parent diff access', () => {
    const source = { kind: 'turn' as const, directory: '/child-worktree', sessionID: 'child-session', messageID: 'tool-message', path: '/child-worktree/a.ts', files: [{ path: '/child-worktree/a.ts', before: '', after: 'snapshot only' }] };
    const request: DesktopPanelContentRequest = { kind: 'file-diff', source };
    const renderer = vi.fn(() => 'actual historical source'), commit = vi.fn(() => true);
    expect(admitDesktopPanelContent({ 'file-diff': renderer }, request, context, commit)).toBe(true);
    expect(renderDesktopPanelContent({ 'file-diff': renderer }, request, context)).toBe('actual historical source');
    expect(renderer).toHaveBeenCalledExactlyOnceWith(request, context);
    expect(() => renderDesktopPanelContent({ diff: () => 'wrong parent' }, { kind: 'diff', source }, context)).toThrow();
    expect(() => renderDesktopPanelContent({ 'file-diff': renderer }, { ...request, source: { ...source, files: [{ path: source.path }] } }, context)).toThrow('desktop_panel_historical_snapshot_required');
    expect(() => renderDesktopPanelContent({ 'file-diff': renderer }, { ...request, source: { ...source, path: '/outside/a.ts' } }, context)).toThrow();
  });
});
