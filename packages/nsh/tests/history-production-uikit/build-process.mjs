import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

function processes() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 10000 }).trim().split('\n').map(line => {
    const fields = line.trim().split(/\s+/);
    return { pid: Number(fields[0]), parent: Number(fields[1]), birth: fields.slice(2).join(' ') };
  });
}

async function terminateOwnedTree(pid, birth) {
  const snapshot = processes(), root = snapshot.find(row => row.pid === pid && row.birth === birth);
  if (!root) return [];
  const owned = [root];
  function signal(row, name) {
    if (!processes().some(current => current.pid === row.pid && current.birth === row.birth)) return;
    try { process.kill(row.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  signal(root, 'SIGSTOP');
  for (;;) {
    const descendants = processes().filter(row => owned.some(parent => parent.pid === row.parent) && !owned.some(value => value.pid === row.pid));
    if (!descendants.length) break;
    for (const row of descendants) { signal(row, 'SIGSTOP'); owned.push(row); }
  }
  for (const row of [...owned].reverse()) signal(row, 'SIGKILL');
  return owned.map(row => row.pid);
}

// Swift build stages only. No shell, broad process matching, or group kill.
export function runSwiftBuildStage(command, args, cwd, { timeoutMs = 240000, stage, report = event => console.log(JSON.stringify(event)) } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now(), child = spawn(command, args, { cwd, stdio: 'inherit' });
    let settled = false, terminating = false, timer;
    const birth = child.pid ? processes().find(row => row.pid === child.pid)?.birth : undefined;
    function finish(error, status, signal, ownedPIDs = []) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
      report({ stage, phase: error ? 'error' : 'end', at: new Date().toISOString(), pid: child.pid,
        elapsedMs: performance.now() - started, status, signal, errorStage: error ? stage : undefined,
        code: error?.code, ownedPIDs });
      if (error) { error.stage = stage; error.ownedPIDs = ownedPIDs; reject(error); } else { resolve(); }
    }
    async function stop(code) {
      if (settled || terminating) return;
      terminating = true;
      const error = Object.assign(new Error(`${stage} failed: ${code}`), { code });
      try { finish(error, child.exitCode, child.signalCode, birth ? await terminateOwnedTree(child.pid, birth) : []); }
      catch (cleanup) { error.message += `; cleanup failed: ${cleanup.message}`; finish(error, child.exitCode, child.signalCode); }
    }
    function interrupt() { void stop('SIGINT'); }
    function terminate() { void stop('SIGTERM'); }
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    report({ stage, phase: 'start', at: new Date().toISOString(), pid: child.pid, timeoutMs });
    timer = setTimeout(() => { void stop('ETIMEDOUT'); }, timeoutMs);
    child.once('error', error => finish(error, null, null));
    child.once('close', (status, signal) => {
      if (terminating) return;
      finish(status === 0 ? null : new Error(`${stage} failed: status=${status} signal=${signal}`), status, signal);
    });
  });
}
