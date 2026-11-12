import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Fixed clocks/IDs allow before/after evidence to identify the identical workload.
export function createDataset({ localOnly = false } = {}) {
  const epoch = 1_790_000_000_000;
  const hosts = localOnly ? [] : Array.from({ length: 5 }, (_, i) => ({
    id: `perf-host-${i + 1}`, name: `Performance host ${i + 1}`,
    source: ['direct', 'relay', 'ssh'][i % 3], state: 'connected',
    capabilities: { remoteProjects: true },
  }));
  const projects = Array.from({ length: 50 }, (_, i) => {
    // First ten have identical name/path but distinct machine identity.
    const hostId = localOnly || i % 6 === 0 ? undefined : hosts[(i - 1 + 5) % 5].id;
    const group = i < 10 ? Math.floor(i / 2) : i;
    return {
      id: `perf-project-${i}`, path: `/workspace/project-${group}`,
      label: `Project ${group}`, ...(hostId ? { hostId, remoteProjectId: `remote-project-${i}`, remoteState: 'ok' } : {}),
      addedAt: epoch, lastOpenedAt: epoch,
    };
  });
  // Local control preserves project cardinality without collapsing paired paths.
  if (localOnly) for (const p of projects) p.path = `/workspace/${p.id}`;
  const summaries = projects.flatMap(project => Array.from({ length: 100 }, (_, n) => ({
    id: `perf-session-${project.id.slice(13)}-${n}`,
    projectID: project.remoteProjectId ?? project.id, directory: project.path,
    ...(project.hostId ? { hostId: project.hostId } : {}),
    title: `Session ${n} in ${project.label}`, version: '1',
    time: { created: epoch + n, updated: epoch + n },
  })));
  const streaming = (localOnly ? [undefined] : hosts.slice(0, 3).map(h => h.id))
    .flatMap((hostId, i) => summaries.filter(s => s.hostId === hostId).slice(0, i < 2 ? 2 : 1))
    .slice(0, 5);
  if (localOnly) streaming.push(...summaries.slice(2, 5));
  const catalogs = Object.fromEntries(['models', 'agents', 'providers', 'commands', 'files'].map(kind => [kind,
    Array.from({ length: 300 }, (_, i) => ({ id: `${kind}-${i}`, name: `${kind} ${i}` })),
  ]));
  return { schemaVersion: 1, name: localOnly ? 'L-local-control' : 'L', epoch,
    hosts, projects, summaries, streaming: streaming.map(s => ({ hostId: s.hostId ?? null, sessionId: s.id, directory: s.directory })), catalogs };
}

export function datasetHash(dataset) {
  return createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataset = createDataset({ localOnly: process.argv.includes('--local-only') });
  const output = process.argv.find(a => a.startsWith('--out='))?.slice(6);
  const body = JSON.stringify({ ...dataset, sha256: datasetHash(dataset) }, null, 2) + '\n';
  if (output) writeFileSync(output, body); else process.stdout.write(body);
}
