import { createHost } from '../../features-memory-host.js';

/** Use the existing memory policy's exact initial authority, not hand-made UI state. */
export function featuresUIKitSeed() {
  const host = createHost(), connection = host.call('connection.list', {});
  const read = path => host.call('runtime.request', { path, method: 'GET', expectedHost: connection.runtimeScope }).body;
  const audit = host.call('features.fixture.audit', {});
  const runs = [...audit.runs];
  for (let index = 4; index <= 32; index++) runs.push({ ...audit.runs[0], id: `memory-history-${index}`, sessionId: `memory-history-session-${index}`, startedAt: 1700000000000 - index * 1000, finishedAt: 1700000000100 - index * 1000 });
  return { schemaVersion: 1, connection, settings: read('/api/config/settings'), providers: read('/api/config/catalog/providers').providers, bots: audit.bots, tasks: audit.tasks, runs };
}
