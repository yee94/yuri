import { expect, test } from 'vitest';
import { liveHost } from './tests/live/host.mjs';
import { referenceCandidates, referenceRoute, type ReferenceKind } from './composer-references';
import { record, text } from './model';

test.skipIf(process.env.NSH_LIVE_REFERENCES !== '1')('reference catalogs use the installed Host SDK wire (read only, no prompts/config writes)', async () => {
  const host = await liveHost();
  const catalog = record(await host.request('/api/session?limit=1&order=desc&archived=false'));
  const first = record(Array.isArray(catalog.data) ? catalog.data[0] : null);
  const directory = text(record(first.location).directory) || text(first.directory);
  if (!directory) throw new Error('Live reference directory unavailable');
  for (const kind of ['file', 'directory', 'agent', 'skill', 'session'] as ReferenceKind[]) {
    const query = kind === 'file' ? 'README' : kind === 'directory' ? 'src' : '';
    const response = await host.request(referenceRoute(kind, directory, query));
    const rows = referenceCandidates(kind, response, query, directory);
    // Only booleans/counts are assertions: no credentials or real user content in diagnostics.
    expect(Array.isArray(record(response).data)).toBe(true);
    expect(rows.length <= 12).toBe(true);
    expect(rows.every(row => row.kind === kind && !!row.value && !!row.label)).toBe(true);
  }
}, 120_000);
