import { expect, test } from 'vitest';
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
