import { changesFixtureConnection, verifyChangesFixtureScope } from './chat-changes-fixture-scope.js';

/** Complete historical snapshots need root readiness but must never fetch current Git. */
export function createHost() {
  const saved = changesFixtureConnection('tool-diff-fixture', 'synthetic-tool-diff-lease');
  return { call(name, input) {
    if (name === 'connection.list') return saved;
    if (name === 'runtime.request') verifyChangesFixtureScope(input, saved.runtimeScope);
    throw new Error('Unexpected historical fixture request: ' + name + ' ' + (input?.path ?? ''));
  } };
}
