import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { digest, fail, combineSessions, toNativeTransfer } from './events.js';
import { discoverSources, readSource } from './sources.js';
import { planSettings, applySettings, settingsConfigFingerprint } from './settings.js';
import { createImportStore } from './store.js';
import { detectSourceInstallations } from './installations.js';
import { ensureImportDirectory, resolveImportDirectory } from './targets.js';
import { discoverNative, nativeRevision } from './native.js';

const TTL = 30 * 60 * 1000;
const errorCode = (error) => typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'import_failed';
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const notFound = (error) => error?.status === 404 || error?.response?.status === 404
  || error?._tag === 'SessionNotFoundError' || error?._tag === 'Session.NotFoundError';
const sourceKinds = ['claude', 'codex', 'cursor', 'dsh', 'opencode'];
const sourceKey = (item) => `${item.source}:${item.namespace}:${item.id}`;
const targetID = (items, parentID, merge = false) => `ses_${digest({ version: 1, mode: merge ? 'merge' : 'separate', parentID, sources: items.map(({ source, namespace, id, hash, directory }) => ({ source, namespace, id, hash, directory })) }).slice(0, 32)}`;
const provenanceFor = (group, merge = false) => ({ version: 1, mode: merge ? 'merge' : 'separate', usage: 'unknown', sources: group.map(({ source, namespace, id, hash }) => ({ source, namespace, id, hash })) });

export function createHistoryImportService({ dataDir, createClient, getRuntimeIdentity, registerProject,
  onImported = () => {}, discover = discoverSources, detect = detectSourceInstallations, read = readSource, defaults, store: suppliedStore }) {
  const scans = new Map(); const plans = new Map();
  let active; let running; let scanning = false; let store = suppliedStore;
  const receipts = () => store ??= createImportStore(path.join(dataDir, 'history-import.sqlite'));
  const identity = () => digest(getRuntimeIdentity());
  const prune = (map) => { for (const [id, entry] of map) if (entry.expires < Date.now()) map.delete(id); };
  const remember = (map, entry) => {
    prune(map); if (map.size >= 8) fail('too_many_plans');
    const id = randomUUID(); map.set(id, { ...entry, expires: Date.now() + TTL }); return id;
  };
  const owned = (map, id, owner) => {
    prune(map); const item = map.get(id);
    if (!item || item.owner !== owner || item.runtime !== identity()) fail('plan_expired');
    return item;
  };
  const targetDirectory = resolveImportDirectory;
  const discoverAll = async (input = {}) => {
    const sources = input.sources ?? sourceKinds;
    if (!Array.isArray(sources) || !sources.length || sources.some((source) => !sourceKinds.includes(source))) fail('invalid_source');
    if (input.limitPerSource !== undefined && (!Number.isInteger(input.limitPerSource) || input.limitPerSource < 1 || input.limitPerSource > 10)) fail('invalid_preview_limit');
    if (input.includeCounts !== undefined && typeof input.includeCounts !== 'boolean') fail('invalid_source');
    if (input.roots !== undefined && (!Array.isArray(input.roots) || input.roots.length > 16
      || input.roots.some((root) => !sourceKinds.includes(root.source) || root.source === 'opencode' || typeof root.path !== 'string' || !path.isAbsolute(root.path)))) fail('invalid_source');
    const external = sources.filter((source) => source !== 'opencode');
    const result = external.length ? await discover({ ...input, sources: external }, defaults) : { sessions: [], errors: [], descriptors: new Map() };
    if (!sources.includes('opencode')) return result;
    const native = await discoverNative(createClient(), identity(), input);
    const combined = [...result.sessions, ...native.sessions];
    const sessions = combined.slice(0, 5000); const keys = new Set(sessions.map((session) => session.key));
    const overflow = [...new Set(combined.slice(5000).map((session) => session.source))].map((source) => ({ source, code: 'too_many_sessions' }));
    return { sessions, errors: [...result.errors, ...native.errors, ...overflow],
      descriptors: new Map([...result.descriptors, ...native.descriptors].filter(([key]) => keys.has(key))), counts: input.includeCounts ? { ...result.counts, ...native.counts } : undefined };
  };
  const readRecord = async (descriptor) => {
    if (descriptor.source !== 'opencode') return read(descriptor);
    const info = await createClient().session.get({ sessionID: descriptor.sessionID }, { signal: AbortSignal.timeout(10000) });
    if (info.id !== descriptor.sessionID) fail('session_conflict');
    return { ...nativeRevision(info, descriptor.namespace), title: info.title || info.id, events: [], warnings: [], descriptor, native: info };
  };
  const scan = async (input, owner) => {
    if (scanning || active) fail('import_busy');
    scanning = true; const runtime = identity();
    try {
      const result = await discoverAll(input);
      const installations = await detect((input?.sources ?? sourceKinds).filter((source) => source !== 'opencode'));
      if ((input?.sources ?? sourceKinds).includes('opencode')) installations.opencode = result.errors.some((error) => error.source === 'opencode') ? null : true;
      if (runtime !== identity()) fail('runtime_changed');
      const sampled = input?.limitPerSource !== undefined;
      const id = remember(scans, { owner, runtime, sampled, descriptors: result.descriptors });
      return { id, host: true, sampled, installations, counts: result.counts, sessions: result.sessions, errors: result.errors };
    } finally { scanning = false; }
  };
  const imported = async (input, owner) => {
    const source = owned(scans, input.scanID, owner);
    if (!source.sampled) fail('incomplete_scan');
    const revisions = [...source.descriptors].map(([key, descriptor]) => ({ key, ...descriptor.revision })).filter((item) => item.id);
    if (revisions.length > 50) fail('invalid_selection');
    const bySource = new Map(revisions.map((item) => [sourceKey(item), item]));
    const resolved = new Map();
    const resolve = async (item, visiting = new Set()) => {
      if (resolved.has(item.key)) return resolved.get(item.key);
      if (visiting.has(item.key)) return null;
      visiting.add(item.key);
      const directory = await targetDirectory(item.directory || input.directory || '', true);
      let parentID;
      if (item.parentID) {
        const parent = bySource.get(`${item.source}:${item.namespace}:${item.parentID}`);
        if (!parent) return null;
        const resolvedParent = await resolve(parent, visiting);
        if (!resolvedParent) return null;
        parentID = resolvedParent.sessionID;
      }
      const normalized = { ...item, directory };
      const result = { directory, sessionID: item.source === 'opencode' ? item.id : targetID([normalized], parentID), provenance: provenanceFor([item]) };
      resolved.set(item.key, result); return result;
    };
    const states = {}; const pending = [...revisions]; const client = createClient(); const signal = AbortSignal.timeout(5000);
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (pending.length) {
        const item = pending.shift(); states[item.key] = 'unknown';
        if (signal.aborted || source.runtime !== identity()) continue;
        try {
          const expected = await resolve(item);
          if (!expected) continue;
          const existing = await client.session.get({ sessionID: expected.sessionID }, { signal });
          if (existing.id === expected.sessionID && existing.location?.directory === expected.directory
            && (item.source === 'opencode' || same(existing.metadata?.historyImport, expected.provenance))) states[item.key] = 'imported';
        } catch (error) { if (notFound(error)) states[item.key] = 'available'; }
      }
    }));
    if (source.runtime !== identity()) fail('runtime_changed');
    return { states };
  };
  const prepare = async (input, owner, progress) => {
    const source = owned(scans, input.scanID, owner);
    if (source.sampled) fail('incomplete_scan');
    if (!Array.isArray(input.sessions) || !input.sessions.length || input.sessions.length > 5000
      || new Set(input.sessions.map((item) => item.key)).size !== input.sessions.length) fail('invalid_selection');
    const selected = []; const settings = []; const configHashes = {}; const settingsSeen = new Set(); const failures = [];
    for (const item of input.sessions) {
      if (progress && !progress.valid()) fail('runtime_changed');
      try {
      const descriptor = source.descriptors.get(item.key);
      if (!descriptor) fail('invalid_selection');
      const directory = await targetDirectory(item.directory, true);
       const session = await readRecord(descriptor);
      const settingKey = `${session.source}:${session.directory}:${directory}`;
       if (session.source === 'opencode' && directory !== session.directory) fail('invalid_target');
       if (session.source !== 'opencode' && input.settings === true && !settingsSeen.has(settingKey)) {
         settingsSeen.add(settingKey);
         try {
           const additions = await planSettings(session.source, session.directory, directory);
           if (settings.length + additions.length > 200 || [...settings, ...additions].reduce((bytes, rule) => bytes + Buffer.byteLength(rule.content), 0) > 4 * 1024 * 1024) fail('settings_too_large');
           const fingerprint = await settingsConfigFingerprint(directory);
           settings.push(...additions); configHashes[directory] = fingerprint;
         } catch (error) {
           if (!progress) throw error;
           failures.push({ key: `settings-${digest(settingKey)}`, phase: 'settings', status: 'failed', code: errorCode(error) });
         }
      }
      selected.push({ key: item.key, descriptor, hash: session.hash, id: session.id, source: session.source,
        namespace: session.namespace, parentID: session.parentID, directory, title: session.title,
        messages: session.events.length, warnings: session.warnings });
      } catch (error) {
        if (!progress) throw error;
        failures.push({ key: item.key, phase: 'validation', status: 'failed', code: errorCode(error) });
      }
      progress?.advance();
      await setImmediate();
    }
    if (input.merge === true && (selected.some((item) => item.source === 'opencode') || selected.length < 2 || new Set(selected.map((item) => item.directory)).size !== 1)) fail('invalid_merge');
    if (source.runtime !== identity()) fail('runtime_changed');
    const selectedIDs = new Set(selected.map((item) => `${item.source}:${item.namespace}:${item.id}`));
    if (selectedIDs.size !== selected.length) fail('invalid_selection');
    for (const item of selected) if (item.parentID && !selectedIDs.has(`${item.source}:${item.namespace}:${item.parentID}`)) item.warnings = [...item.warnings, 'parent_detached'];
    const id = remember(plans, { owner, runtime: source.runtime, selected, settings, configHashes, failures, merge: input.merge === true });
    return { id, merge: input.merge === true, sessions: selected.map(({ descriptor: _, namespace: _namespace, ...item }) => item),
      settings: settings.map(({ sourceDirectory: _, ...item }) => item), expires: Date.now() + TTL };
  };
  const preview = (input, owner) => prepare(input, owner);

  // A deterministic target ID plus provenance verification makes retries safe
  // after timeout, process restart, and a receipt write failure. 409 alone is not
  // treated as success. No append/overwrite API or prompt execution is used.
  const importOne = async (client, transfer, provenance) => {
    const verify = (existing) => {
      if (existing.id !== transfer.info.id || !same(existing.metadata?.historyImport, provenance) || existing.location?.directory !== transfer.location.directory) fail('session_conflict');
      return existing;
    };
    try { return { session: verify(await client.session.get({ sessionID: transfer.info.id }, { signal: AbortSignal.timeout(30000) })), status: 'skipped' }; }
    catch (error) { if (!notFound(error)) throw error; }
    try {
      await client.session.import(transfer, { signal: AbortSignal.timeout(60000) });
      return { session: verify(await client.session.get({ sessionID: transfer.info.id }, { signal: AbortSignal.timeout(30000) })), status: 'imported' };
    }
    catch (error) {
      // A response may be lost after commit. Recover only by exact authority.
      try { return { session: verify(await client.session.get({ sessionID: transfer.info.id }, { signal: AbortSignal.timeout(30000) })), status: 'skipped' }; }
      catch (verification) { if (verification?.code === 'session_conflict') throw verification; throw error; }
    }
  };
  const run = async (job, plan, decisions) => {
    let position = 0; let failed = false;
    const record = (result) => {
      receipts().append(job.id, position++, result); if (result.status === 'failed') failed = true;
      receipts().progress(job.id, { phase: 'importing', completed: position, total: job.total });
    };
    const valid = () => !job.cancelled && plan.runtime === identity();
    const mapID = new Map(); const successful = new Set(); const registered = new Set();
    const pending = [...plan.selected]; const ordered = []; const visited = new Set(); const blocked = new Map();
    const bySource = new Map(pending.map((item) => [sourceKey(item), item]));
    const visit = (item) => {
      const chain = []; const positions = new Map(); let current = item;
      while (current && !visited.has(sourceKey(current))) {
        const key = sourceKey(current);
        if (positions.has(key)) {
          for (const cyclic of chain.slice(positions.get(key))) blocked.set(sourceKey(cyclic), 'invalid_parent_graph');
          break;
        }
        positions.set(key, chain.length); chain.push(current);
        current = bySource.get(`${current.source}:${current.namespace}:${current.parentID}`);
      }
      for (const entry of chain.reverse()) {
        const key = sourceKey(entry); const parentKey = `${entry.source}:${entry.namespace}:${entry.parentID}`;
        if (!blocked.has(key) && blocked.has(parentKey)) blocked.set(key, 'parent_failed');
        if (!blocked.has(key)) ordered.push(entry);
        visited.add(key);
      }
    };
    try {
      for (const failure of plan.failures ?? []) record(failure);
      if (plan.merge) ordered.push(...pending);
      else for (const item of pending) visit(item);
      for (const item of pending) if (blocked.has(sourceKey(item))) record({ key: item.key, phase: 'session', status: 'failed', code: blocked.get(sourceKey(item)) });
       for (const item of ordered) mapID.set(sourceKey(item), item.source === 'opencode' ? item.id : targetID([item], mapID.get(`${item.source}:${item.namespace}:${item.parentID}`)));
      const client = createClient();
      const groups = plan.merge ? [plan.selected] : ordered.map((item) => [item]);
      for (const group of groups) {
        if (!valid()) break;
        const item = group[0]; const key = group.map((entry) => entry.key).join(':');
        const parentKey = `${item.source}:${item.namespace}:${item.parentID}`;
        const parentID = !plan.merge && mapID.has(parentKey) ? mapID.get(parentKey) : undefined;
         const sessionID = item.source === 'opencode' ? item.id : targetID(group, parentID, plan.merge);
        try {
          const sessions = [];
          for (const entry of group) {
             const session = await readRecord(entry.descriptor);
            if (session.hash !== entry.hash) fail('source_changed');
            if (await targetDirectory(entry.directory, true) !== entry.directory) fail('target_changed');
            sessions.push(session);
          }
          if (parentID && !successful.has(parentKey)) fail('parent_failed');
          if (!valid()) break;
           if (item.source === 'opencode') {
             await targetDirectory(item.directory, false);
             if (!valid()) break;
             if (!registered.has(item.directory)) { await registerProject({ path: item.directory }); registered.add(item.directory); }
             if (!valid()) break;
             let index = 'refreshed';
             try { await onImported(sessions[0].native); } catch { index = 'failed'; }
             successful.add(sourceKey(item));
             record({ key, phase: 'session', sessionID, directory: item.directory, status: 'skipped', project: 'registered', index });
             if (index === 'failed') failed = true;
             continue;
           }
           const provenance = provenanceFor(group, plan.merge);
          const session = plan.merge ? { title: sessions.map((entry) => entry.title).join(' + ').slice(0, 200), events: combineSessions(sessions) } : sessions[0];
          const transfer = toNativeTransfer(session, item.directory, sessionID, provenance, parentID);
          await ensureImportDirectory(item.directory);
          if (!valid()) break;
          if (!registered.has(item.directory)) { await registerProject({ path: item.directory }); registered.add(item.directory); }
          if (!valid()) break;
          const result = await importOne(client, transfer, provenance);
          successful.add(sourceKey(item));
          const project = 'registered'; let index = 'refreshed';
          try { if (valid()) await onImported(result.session); } catch { index = 'failed'; }
          record({ key, phase: 'session', sessionID, directory: item.directory, status: result.status, project, index });
          if (project === 'failed' || index === 'failed') failed = true;
        } catch (error) { record({ key, phase: 'session', sessionID, status: 'failed', code: errorCode(error) }); }
        await setImmediate();
      }
      const hashes = { ...plan.configHashes };
      for (const item of plan.settings) {
        if (!valid()) break;
        try {
          if (!registered.has(item.directory)) fail('project_unavailable');
          const result = await applySettings(item, decisions[item.key] ?? 'keep', hashes[item.directory]);
          hashes[item.directory] = result.configHash ?? hashes[item.directory];
          record({ key: item.key, phase: 'settings', status: result.status, target: item.target });
        } catch (error) { record({ key: item.key, phase: 'settings', status: 'failed', code: errorCode(error) }); }
      }
      receipts().finish(job.id, !valid() ? job.cancelled ? 'cancelled' : 'interrupted' : failed ? 'partial' : 'completed');
    } catch (error) {
      const progress = receipts().get(job.id, job.owner, job.runtime)?.progress;
      receipts().progress(job.id, { ...(progress ?? { phase: 'importing', completed: position, total: job.total }), code: errorCode(error) });
      receipts().finish(job.id, 'interrupted');
    } finally { if (active === job) active = undefined; }
  };
  const runSources = async (job, input) => {
    const valid = () => !job.cancelled && job.runtime === identity();
    let scanID; let planID;
    try {
      receipts().progress(job.id, { phase: 'scanning', completed: 0, total: 0 });
       const found = await discoverAll({ sources: input.sources });
      if (!valid()) { receipts().finish(job.id, job.cancelled ? 'cancelled' : 'interrupted'); return; }
      let completed = 0;
      const total = found.sessions.length;
      receipts().progress(job.id, { phase: 'validating', completed, total });
      scanID = remember(scans, { owner: job.owner, runtime: job.runtime, sampled: false, descriptors: found.descriptors });
      const prepared = total ? await prepare({ scanID, sessions: found.sessions.map((session) => ({ key: session.key, directory: session.directory || input.directory || '' })), settings: true, merge: false }, job.owner, {
        valid, advance: () => receipts().progress(job.id, { phase: 'validating', completed: ++completed, total }),
      }) : null;
      planID = prepared?.id;
      if (!valid()) { receipts().finish(job.id, job.cancelled ? 'cancelled' : 'interrupted'); return; }
      const plan = prepared ? owned(plans, prepared.id, job.owner) : { runtime: job.runtime, selected: [], settings: [], configHashes: {}, failures: [], merge: false };
      plan.failures.push(...found.errors.map((error, index) => ({ key: `scan-${index}`, phase: 'scan', status: 'failed', code: error.code })));
      job.total = plan.selected.length + plan.settings.length + plan.failures.length;
      receipts().progress(job.id, { phase: 'importing', completed: 0, total: job.total }, job.total);
      await run(job, plan, {});
    } catch (error) {
      const progress = receipts().get(job.id, job.owner, job.runtime)?.progress;
      receipts().progress(job.id, { ...(progress ?? { phase: 'scanning', completed: 0, total: 0 }), code: errorCode(error) });
      receipts().finish(job.id, !valid() ? job.cancelled ? 'cancelled' : 'interrupted' : 'partial');
    } finally {
      scans.delete(scanID); plans.delete(planID);
      if (active === job) active = undefined;
    }
  };
  const start = async (input, owner) => {
    if (input.confirm !== true) fail('confirmation_required');
    if (input.sources !== undefined) {
      if (!Array.isArray(input.sources) || !input.sources.length || new Set(input.sources).size !== input.sources.length
         || input.sources.some((source) => !sourceKinds.includes(source))) fail('invalid_source');
      if (input.directory != null && (typeof input.directory !== 'string' || !path.isAbsolute(input.directory) || input.directory.length > 4096)) fail('invalid_target');
      if (active || scanning) fail('import_busy');
      const job = { id: randomUUID(), owner, runtime: identity(), cancelled: false, total: 0 };
      const request = { sources: [...input.sources], directory: input.directory ?? null };
      receipts().create(job.id, owner, job.runtime, 0, request); active = job;
      running = runSources(job, request);
      return receipts().get(job.id, owner, job.runtime);
    }
    const plan = owned(plans, input.planID, owner);
    if (plan.jobID) return receipts().get(plan.jobID, owner, plan.runtime);
    if (active) fail('import_busy');
    const decisions = input.decisions ?? {};
    if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)
      || Object.entries(decisions).some(([key, value]) => !plan.settings.some((item) => item.key === key) || !['keep', 'replace', 'copy'].includes(value))) fail('invalid_selection');
    const id = randomUUID(); const job = { id, owner, runtime: plan.runtime, cancelled: false, total: (plan.merge ? 1 : plan.selected.length) + plan.settings.length };
    receipts().create(id, owner, plan.runtime, job.total);
    plan.jobID = id; active = job;
    // Host-owned work survives dialog dismissal. The persistent receipts expose
    // partial/cancelled/interrupted runs; re-previewing safely retries them.
    running = run(job, plan, decisions);
    return receipts().get(id, owner, plan.runtime);
  };
  const resume = async (input, owner) => {
    if (input.confirm !== true) fail('confirmation_required');
    const runtime = identity(); const previous = receipts().get(input.id, owner, runtime);
    if (!previous) fail('job_missing');
    if (previous.dismissed) fail('job_dismissed');
    if (previous.state === 'completed' || active?.id === input.id && active.owner === owner) return previous;
    if (active || scanning) fail('import_busy');
    const request = receipts().request(input.id, owner, runtime);
    if (!request) fail('resume_request_missing');
    if (!Array.isArray(request.sources) || !request.sources.length || new Set(request.sources).size !== request.sources.length
      || request.sources.some((source) => !sourceKinds.includes(source))) fail('invalid_source');
    if (request.directory != null && (typeof request.directory !== 'string' || !path.isAbsolute(request.directory) || request.directory.length > 4096)) fail('invalid_target');
    const job = { id: previous.id, owner, runtime, cancelled: false, total: 0 };
    receipts().restart(job.id, request); active = job;
    running = runSources(job, request);
    return receipts().get(job.id, owner, runtime);
  };
  return {
    scan, imported, preview, start, resume,
    jobs: (owner) => receipts().unfinished(owner, identity()),
    dismiss: (input, owner) => {
      const runtime = identity(); const job = receipts().get(input.id, owner, runtime);
      if (!job) fail('job_missing');
      if (job.state === 'running' || active?.id === job.id) fail('import_busy');
      if (!receipts().dismiss(job.id, owner, runtime)) fail('import_busy');
      return { id: job.id };
    },
    status: (id, owner) => id ? receipts().get(id, owner, identity()) : receipts().latest(owner, identity()),
    cancel: (id, owner) => {
      const status = receipts().get(id, owner, identity());
      if (!status) fail('job_missing');
      if (active?.id === id && active.owner === owner) active.cancelled = true;
      return status;
    },
    close: async () => { if (active) active.cancelled = true; await running; store?.close(); },
  };
}
