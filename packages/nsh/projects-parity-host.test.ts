import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createHost } from './projects-parity-host.js';
import { withProjectsParityFixture } from './projects-parity-runner.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
describe('Projects isolated Host evidence', () => {
  it('the explicitly granted fixture control sends a real host event instead of directly ingesting unread', () => {
    const hostEvent = vi.fn(), host = createHost({ hostEvent });
    expect(host.call('projects.fixture.complete', {})).toBe(true);
    expect(hostEvent).toHaveBeenCalledOnce(); expect(hostEvent).toHaveBeenCalledWith('runtime.event', { key: 'global', data: JSON.stringify({ type: 'session.execution.succeeded', data: { sessionID: 'root' } }) });
    expect(() => host.call('projects.fixture.complete', { sessionID: 'different' })).toThrow();
    expect(host.call('projects.fixture.audit', {})).toMatchObject({ writes: 0 });
  });
  it('audits real fake-Host writes, rejects unsafe cascade, and fails closed on unrelated requests', () => {
    const host = createHost();
    const read = (path: string, method = 'GET') => host.call('runtime.request', { path, method });
    expect(host.call('projects.fixture.audit', {})).toMatchObject({ writes: 0, rejectedRequests: 0 });
    expect(read('/api/session?parentID=root&limit=50&order=desc').body.cursor.next).toBe('child-page+=');
    expect(read('/api/session?parentID=root&limit=50&order=desc&cursor=child-page%2B%3D').body.data).toHaveLength(2);
    expect(read('/api/session/bad?directory=%2Ffixture%2Frepo', 'DELETE').status).toBe(503);
    expect(() => read('/api/session/root?directory=%2Ffixture%2Frepo', 'DELETE')).toThrow('unsafe ancestor cascade');
    expect(read('/api/session/bad?directory=%2Ffixture%2Frepo', 'DELETE').body).toBe(true);
    expect(read('/api/session/good?directory=%2Ffixture%2Frepo', 'DELETE').body).toBe(true);
    expect(read('/api/session/root?directory=%2Ffixture%2Frepo', 'DELETE').body).toBe(true);
    expect(() => read('/api/fs/write', 'POST')).toThrow();
    expect(() => host.call('projects.fixture.audit', { reset: true })).toThrow();
    expect(host.call('projects.fixture.audit', {})).toMatchObject({ writes: 5, removed: ['bad', 'good', 'root'], rejectedRequests: 2 });
  });
  it('bundles the Host first and grants audit only in a unique temporary config, without modifying production capabilities', () => {
    const before = readFileSync(path.join(root, 'nsh.json'), 'utf8');
    let first = '';
    withProjectsParityFixture(root, (fixture: { directory: string; host: string }) => {
      first = fixture.directory;
      expect(readFileSync(fixture.host, 'utf8')).toContain('createHost');
      const config = JSON.parse(readFileSync(path.join(fixture.directory, 'nsh.json'), 'utf8'));
      expect(config.capabilities).toEqual({ host: ['runtime.request', 'projects.fixture.audit', 'projects.fixture.complete'] });
      expect(config.id).toContain(path.basename(fixture.directory));
    });
    withProjectsParityFixture(root, (fixture: { directory: string }) => { expect(fixture.directory).not.toBe(first); });
    expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(before);
    expect(JSON.parse(before).capabilities.host).not.toContain('projects.fixture.audit');
    expect(JSON.parse(before).capabilities.host).not.toContain('projects.fixture.complete');
  });
});
