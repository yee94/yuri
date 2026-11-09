import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createCommandsHost, createDraftCommandsHost, identity } from './tests/desktop-commands-application/Host.js';
import { createCompactHost } from './tests/local-compact-writer/host.js';

const producers = [{
  name: 'prompt', create: createCommandsHost, lane: 'prompts', target: { kind: 'session', id: identity.sessionID },
  wrongTarget: { kind: 'session', id: 'other-session' },
  path: '/api/session/' + identity.sessionID + '/prompt?directory=' + encodeURIComponent(identity.directory),
  body: { id: 'exact-input', text: 'Synthetic compiled prompt', delivery: 'steer' },
}, {
  name: 'compact', create: createCompactHost, lane: 'compacts', target: { kind: 'session', id: identity.sessionID },
  wrongTarget: { kind: 'session', id: 'other-session' },
  path: '/api/session/' + identity.sessionID + '/compact?directory=' + encodeURIComponent(identity.directory),
  body: { id: 'exact-compact', delivery: 'steer' },
}, {
  name: 'new-session create', create: createDraftCommandsHost, lane: 'creates', target: { kind: 'new-session', id: identity.directory },
  wrongTarget: { kind: 'new-session', id: identity.decoy },
  path: '/api/session', body: { location: { directory: identity.directory } },
}, {
  name: 'created-session prompt', create: createDraftCommandsHost, lane: 'prompts', target: { kind: 'session', id: 'created-from-local' },
  wrongTarget: { kind: 'session', id: identity.sessionID },
  path: '/api/session/created-from-local/prompt?directory=' + encodeURIComponent(identity.directory),
  body: { id: 'exact-created-input', text: 'Synthetic compiled created prompt', delivery: 'steer' },
}, {
  name: 'created-session model', create: createDraftCommandsHost, lane: 'configurations', target: { kind: 'session', id: 'created-from-local' },
  wrongTarget: { kind: 'session', id: identity.sessionID },
  path: '/api/session/created-from-local/model?directory=' + encodeURIComponent(identity.directory),
  body: { model: { providerID: 'fixture', id: 'model' } },
}, {
  name: 'created-session agent', create: createDraftCommandsHost, lane: 'configurations', target: { kind: 'session', id: 'created-from-local' },
  wrongTarget: { kind: 'session', id: identity.sessionID },
  path: '/api/session/created-from-local/agent?directory=' + encodeURIComponent(identity.directory),
  body: { agent: 'build' },
}] as const;

for (const producer of producers) {
  for (const mode of ['no-held-grant', 'missing-grant', 'wrong-target', 'wrong-kind', 'released', 'stale-lease'] as const) {
    test(`synthetic ${producer.name} rejects ${mode} before recording a mutation`, () => {
      const fixture = producer.create(), expectedHost = { hostID: identity.hostID, lease: identity.lease };
      const target = mode === 'wrong-target' ? producer.wrongTarget
        : mode === 'wrong-kind' ? { kind: producer.target.kind === 'session' ? 'new-session' : 'session', id: producer.target.id } : producer.target;
      const grant = mode === 'no-held-grant' ? null : fixture.handlers['desktop.writer.acquire']({ expectedHost, ownerID: 'negative-owner', target });
      if (mode === 'released') fixture.handlers['desktop.writer.release']({ expectedHost, ownerID: grant.ownerID, target, grantID: grant.grantID });
      if (mode === 'stale-lease') { fixture.rotateLease(); expectedHost.lease = fixture.handlers['connection.list']().runtimeScope.lease; }
      const input = { method: 'POST', path: producer.path, body: producer.body, expectedHost,
        ...(mode === 'missing-grant' ? {} : { writerGrant: grant?.grantID ?? 'unissued-grant' }) };
      expect(() => fixture.handlers['runtime.request'](input)).toThrow(/writer_grant_required/);
      expect(fixture[producer.lane]).toEqual([]);
    });
  }
  test(`synthetic ${producer.name} accepts only its exact live native writer grant`, () => {
    const fixture = producer.create(), expectedHost = { hostID: identity.hostID, lease: identity.lease };
    const grant = fixture.handlers['desktop.writer.acquire']({ expectedHost, ownerID: 'positive-owner', target: producer.target });
    const input = { method: 'POST', path: producer.path, body: producer.body, expectedHost, writerGrant: grant.grantID };
    expect(fixture.handlers['runtime.request'](input).status).toBe(producer.lane === 'configurations' ? 204 : 200);
    expect(fixture[producer.lane]).toEqual([input]);
  });
}

for (const endpoint of ['prompt', 'model', 'agent'] as const) {
  test(`created-session ${endpoint} cannot reuse the still-live source grant after create`, () => {
    const fixture = createDraftCommandsHost(), request = fixture.handlers['runtime.request'];
    const expectedHost = { hostID: identity.hostID, lease: identity.lease };
    const grant = fixture.handlers['desktop.writer.acquire']({ expectedHost, ownerID: 'source-owner', target: { kind: 'new-session', id: identity.directory } });
    const source = { method: 'POST', path: '/api/session', body: { location: { directory: identity.directory } }, expectedHost, writerGrant: grant.grantID };
    const response = request(source);
    expect(response.body.id).toBe(fixture.createdID);
    const producer = producers.find(value => value.name === 'created-session ' + endpoint)!;
    expect(() => request({ ...source, path: producer.path, body: producer.body })).toThrow(/writer_grant_required/);
    expect(fixture.creates).toEqual([source]); expect(fixture.prompts).toEqual([]); expect(fixture.configurations).toEqual([]);
  });
}

test('production Chat local commands use the actual writer, selection and scoped recovery on both desktop models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'native-command-root-'));
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'nsh.json'), 'utf8'));
    config.id = 'example.yuri.command-production-root'; config.theme = path.join(root, 'theme.json');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify(config));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-commands-application/Root.tsx'))};\n`);
    for (const file of ['Root.tsx', 'Commands.test.tsx']) writeFileSync(path.join(directory, file), `import ${JSON.stringify(path.join(root, 'tests/desktop-commands-application', file))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Commands.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/\b50 tests: 50 passed\b/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 135_000);
