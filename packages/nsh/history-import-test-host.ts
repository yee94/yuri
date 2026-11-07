import { historySources, type ImportScan } from '../ui/src/lib/historyImport';
import { importRoute, type NativeImportJob } from './history-import-protocol';

export const historyImportTestScope = { hostID: 'history-import-fixture', lease: 'synthetic-history-lease' } as const;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fixture_object'); return value as Record<string, unknown>; };
const exact = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('fixture_keys'); };
export function syntheticImportJob(id = 'synthetic-job', state: NativeImportJob['state'] = 'running'): NativeImportJob {
  return { id, state, created: 100, total: 2, completed: state === 'running' ? 0 : 2, resumable: !['completed', 'partial'].includes(state), dismissed: false,
    progress: { phase: 'importing', completed: state === 'running' ? 0 : 2, total: 2 }, results: state === 'running' ? [] : [{ key: 'synthetic-result', phase: 'session', status: 'imported', sessionID: 'synthetic-session', directory: '/fixture/history' }] };
}
export function syntheticImportScan(): ImportScan {
  return { id: 'synthetic-scan', sampled: true,
    sessions: historySources.flatMap(source => Array.from({ length: 5 }, (_, index) => ({ key: `${source.id}-${index}`, source: source.id, id: `${source.id}-${index}`, title: `${source.name} synthetic ${index}`, directory: '/fixture/history', messages: 2, warnings: [], updated: 100, excerpt: 'Synthetic preview only' }))),
    installations: { claude: true, codex: false, cursor: null, dsh: true, opencode: true },
    counts: { claude: { value: 10, approximate: true }, codex: { value: 0, approximate: false }, cursor: { value: null, approximate: true }, dsh: { value: 5, approximate: false }, opencode: { value: 50, approximate: false } }, errors: [] };
}

/** Test-only strict raw Host. Every supported method/shape is explicit. Scripted
 * failures are deterministic, never a real scan/import/install/FS operation. */
export function createHistoryImportTestHost(options: { jobs?: NativeImportJob[]; latestID?: string; scan?: ImportScan; allow?: readonly ('start' | 'resume' | 'cancel' | 'dismiss' | 'scan' | 'imported')[] } = {}) {
  const jobs = new Map((options.jobs ?? []).map(job => [job.id, clone(job)]));
  let latest = options.latestID ?? options.jobs?.at(-1)?.id ?? null, started = 0;
  const requests: Array<{ path: string; method: string; body?: unknown }> = [], mutations: string[] = [], rejected: string[] = [];
  const failures = new Map<string, Array<{ status?: number; code?: string; lost?: boolean; malformed?: boolean }>>();
  const scan = clone(options.scan ?? syntheticImportScan());
  const summary = () => [...jobs.values()].filter(job => !['completed', 'partial'].includes(job.state) && !job.dismissed).sort((a, b) => a.created - b.created).map(job => ({ ...clone(job), results: [], failures: job.results.filter(result => result.status === 'failed' || result.project === 'failed' || result.index === 'failed').length }));
  function raw(name: string, input: unknown): unknown {
    try {
      if (name !== 'runtime.request') throw new Error('fixture_native');
      const request = object(input), method = request.method;
      exact(request, method === 'GET' ? ['path', 'method', 'expectedHost'] : ['path', 'method', 'expectedHost', 'body']);
      const scope = object(request.expectedHost); exact(scope, ['hostID', 'lease']);
      if (scope.hostID !== historyImportTestScope.hostID || scope.lease !== historyImportTestScope.lease) throw new Error('fixture_scope');
      if (typeof request.path !== 'string' || !['GET', 'POST'].includes(String(method))) throw new Error('fixture_wire');
      const path = request.path, route = path.startsWith(importRoute('')) ? path.slice(importRoute('').length) : '';
      let execute: () => unknown;
      if (method === 'GET') {
        if (route === 'job') execute = () => latest ? clone(jobs.get(latest) ?? null) : null;
        else if (route === 'jobs') execute = summary;
        else if ([...jobs.keys()].some(id => route === `job?id=${encodeURIComponent(id)}`)) execute = () => clone(jobs.get(decodeURIComponent(route.slice(7))) ?? null);
        else throw new Error('fixture_route');
      } else {
        if (!options.allow?.includes(route as NonNullable<typeof options.allow>[number])) throw new Error('fixture_consent');
        const body = object(request.body);
        if (route === 'scan') {
          exact(body, ['sources', 'limitPerSource', 'includeCounts']);
          if (JSON.stringify(body.sources) !== JSON.stringify(historySources.map(source => source.id)) || body.limitPerSource !== 5 || body.includeCounts !== true) throw new Error('fixture_scan');
          execute = () => clone(scan);
        } else if (route === 'imported') {
          exact(body, ['scanID', 'directory']); if (body.scanID !== scan.id || body.directory !== '/fixture/history') throw new Error('fixture_imported');
          execute = () => ({ states: Object.fromEntries(scan.sessions.map((session, index) => [session.key, index === 0 ? 'imported' : index === 1 ? 'unknown' : 'available'])) });
        } else if (route === 'start') {
          exact(body, ['sources', 'directory', 'confirm']);
          if (body.confirm !== true || body.directory !== '/fixture/history' || !Array.isArray(body.sources) || !body.sources.length || new Set(body.sources).size !== body.sources.length || body.sources.some(value => !historySources.some(source => source.id === value))) throw new Error('fixture_start');
          execute = () => { const job = syntheticImportJob(`synthetic-start-${++started}`); jobs.set(job.id, job); latest = job.id; mutations.push('start'); return clone(job); };
        } else if (['resume', 'cancel', 'dismiss'].includes(route)) {
          exact(body, route === 'resume' ? ['id', 'confirm'] : ['id']);
          const job = typeof body.id === 'string' ? jobs.get(body.id) : null;
          if (!job || route === 'resume' && body.confirm !== true) throw new Error('fixture_target');
          execute = () => {
            if (route === 'resume') { if (!job.resumable) return { fixtureFailure: 'resume_request_missing' }; if (job.state !== 'running') { jobs.set(job.id, { ...job, state: 'running', completed: 0, results: [], progress: { phase: 'scanning', completed: 0, total: 0 } }); mutations.push('resume'); } return clone(jobs.get(job.id)); }
            if (route === 'dismiss') { if (job.state === 'running') return { fixtureFailure: 'import_busy' }; job.dismissed = true; if (latest === job.id) latest = null; mutations.push('dismiss'); return { id: job.id }; }
            mutations.push('cancel'); return clone(job); // cooperative; scripted completion is separate.
          };
        } else throw new Error('fixture_route');
      }
      requests.push({ path, method: String(method), ...(request.body === undefined ? {} : { body: clone(request.body) }) });
      const script = failures.get(route)?.shift();
      if (script?.status) return { status: script.status, body: { code: script.code ?? 'import_failed' } };
      const result = execute();
      if (script?.lost) throw new Error('synthetic_lost_response');
      if (script?.malformed) return { status: 200, body: { success: true } };
      if (result && typeof result === 'object' && 'fixtureFailure' in result) return { status: 400, body: { code: result.fixtureFailure } };
      return { status: 200, body: result };
    } catch (error) { if (error instanceof Error && error.message.startsWith('fixture_')) rejected.push(error.message); throw error; }
  }
  return { raw, audit: () => clone({ requests, mutations, rejected, jobs: [...jobs.values()] }),
    script: (route: string, value: { status?: number; code?: string; lost?: boolean; malformed?: boolean }) => failures.set(route, [...(failures.get(route) ?? []), value]),
    replace: (job: NativeImportJob) => { if (!jobs.has(job.id)) throw new Error('fixture_missing'); jobs.set(job.id, clone(job)); },
  };
}
