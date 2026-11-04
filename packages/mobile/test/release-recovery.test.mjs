import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecovery } from '../../../scripts/recover-release.mjs';

function fixture() {
  const names = [
    'create-release', 'build-desktop-electron-macos (arm64)',
    'build-desktop-electron-windows (x64)', 'build-desktop-electron-linux (x64)',
    'build-desktop-electron-linux (arm64)', 'publish-electron-linux',
    'Publish npm packages', 'mobile-release / Android signed release',
  ];
  return {
    repository: 'example/app', version: '0.1.0', tagSha: 'original-sha',
    run: { repository: { full_name: 'example/app' }, path: '.github/workflows/release.yml', status: 'completed', event: 'push', head_sha: 'original-sha', run_number: 5 },
    release: { tag_name: 'v0.1.0', draft: true, id: 42 },
    jobs: [...names.map(name => ({ name, conclusion: 'success' })), {
      name: 'mobile-release / iOS TestFlight upload', conclusion: 'failure',
      steps: [
        { name: 'Upload to TestFlight', conclusion: 'success' },
        { name: 'Publish build to external TestFlight group', conclusion: 'failure' },
      ],
    }],
  };
}

test('reuses original source and build number when only legacy external review failed', () => {
  expect(validateRecovery(fixture())).toEqual({ source_sha: 'original-sha', build_number: '5', release_id: '42' });
});

test.each(['build-desktop-electron-macos (arm64)', 'Publish npm packages', 'mobile-release / Android signed release'])('rejects incomplete %s', name => {
  const input = fixture();
  input.jobs.find(job => job.name === name).conclusion = 'failure';
  expect(() => validateRecovery(input)).toThrow('Cannot reuse incomplete');
});

test.each(['Archive iOS app', 'Upload to TestFlight', 'Queue external TestFlight review'])('does not disguise %s failure as a successful release', name => {
  const input = fixture();
  input.jobs.at(-1).steps.at(-1).name = name;
  expect(() => validateRecovery(input)).toThrow();
});

test('rejects missing platform evidence and changed tags', () => {
  const input = fixture();
  input.jobs.pop();
  expect(() => validateRecovery(input)).toThrow('iOS');
  input.tagSha = 'different-sha';
  expect(() => validateRecovery(input)).toThrow('original tagged source');
});

test('rejects unrelated runs and already-published releases', () => {
  const input = fixture();
  input.run.event = 'pull_request';
  expect(() => validateRecovery(input)).toThrow('completed Release run');
  input.run.event = 'push';
  input.release.draft = false;
  expect(() => validateRecovery(input)).toThrow('existing draft');
});

function publishedDeploymentFailure() {
  const input = fixture();
  input.run.conclusion = 'failure';
  input.release.draft = false;
  const ios = input.jobs.at(-1);
  ios.conclusion = 'success';
  ios.steps = [{ name: 'Upload to TestFlight', conclusion: 'success' }];
  input.jobs.push({
    name: 'finalize-release', conclusion: 'failure',
    steps: [
      { name: 'Publish release', conclusion: 'success' },
      { name: 'Deploy update service to Vercel', conclusion: 'failure' },
    ],
  });
  return input;
}

test('resumes a published release only after its update-service deployment failed', () => {
  expect(validateRecovery(publishedDeploymentFailure())).toEqual({
    source_sha: 'original-sha', build_number: '5', release_id: '42',
  });
});

test.each(['run succeeded', 'publication failed', 'deployment succeeded', 'unrelated failure', 'duplicate finalize'])('rejects published recovery when %s', reason => {
  const input = publishedDeploymentFailure();
  const finalize = input.jobs.at(-1);
  if (reason === 'run succeeded') input.run.conclusion = 'success';
  if (reason === 'publication failed') finalize.steps[0].conclusion = 'failure';
  if (reason === 'deployment succeeded') finalize.steps[1].conclusion = 'success';
  if (reason === 'unrelated failure') finalize.steps[1].name = 'Verify complete release asset inventory';
  if (reason === 'duplicate finalize') input.jobs.push(structuredClone(finalize));
  expect(() => validateRecovery(input)).toThrow();
});

test.each(['draft', 'published', 'missing', 'duplicate'])('recovery CLI handles oversized paginated release history (%s)', mode => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-recovery-'));
  const input = mode === 'published' ? publishedDeploymentFailure() : fixture();
  const body = 'x'.repeat(2 * 1024 * 1024);
  const count = mode === 'missing' ? 0 : mode === 'duplicate' ? 2 : 1;
  const pages = [
    [{ tag_name: 'v0.0.9', body }],
    Array.from({ length: count }, () => ({ ...input.release, body })),
  ];
  const output = path.join(dir, 'output');
  try {
    writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ ...input, pages }));
    writeFileSync(path.join(dir, 'gh'), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.env.RECOVERY_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
const endpoint = args.find(arg => arg.startsWith('repos/'));
if (args.includes('--jq') && args.includes('--slurp')) throw new Error('--slurp cannot be combined with --jq');
let result;
let jsonLines = false;
if (endpoint.endsWith('/releases?per_page=100')) {
  const query = args[args.indexOf('--jq') + 1];
  if (args.includes('--jq')) {
    if (query !== '.[] | select(.tag_name == "v0.1.0") | {id, tag_name, draft} | @json') throw new Error('Unexpected release projection');
    result = data.pages.flat().filter(release => release.tag_name === 'v0.1.0').map(({ id, tag_name, draft }) => ({ id, tag_name, draft }));
    jsonLines = true;
  } else result = data.pages;
} else if (endpoint.includes('/jobs?')) result = [{ jobs: data.jobs }];
else if (endpoint.includes('/actions/runs/')) result = data.run;
else if (endpoint.includes('/commits/')) result = { sha: data.tagSha };
else throw new Error('Unexpected endpoint');
fs.writeFileSync(1, jsonLines ? result.map(value => JSON.stringify(value)).join('\n') : JSON.stringify(result));
`, { mode: 0o755 });
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/recover-release.mjs');
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, GH_TOKEN: 'test-fixture',
        GITHUB_REPOSITORY: input.repository, RECOVERY_RUN_ID: '123', VERSION: input.version,
        GITHUB_OUTPUT: output, RECOVERY_FIXTURE: path.join(dir, 'fixture.json') },
    });
    expect(result.stderr.includes('ENOBUFS'), 'Recovery CLI must not buffer full release bodies or assets').toBe(false);
    if (count !== 1) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Expected exactly one existing release');
    } else {
      expect(result.status).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('source_sha=original-sha\nbuild_number=5\nrelease_id=42\n');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
