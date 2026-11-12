import fs from 'node:fs';
import path from 'node:path';

export async function readHelperAx({ helper, root, timeoutMs = 60000, fetchImpl = fetch }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Bounded AX timeout required');
  const gate = path.join(root, 'ax-helper-reset-required.json');
  if (fs.existsSync(gate) && JSON.parse(fs.readFileSync(gate)).helperPid === helper.pid) throw new Error('Previous AX request timed out; restart only this task helper before another AX request');
  const lock = path.join(root, 'ax-request.lock');
  const handle = fs.openSync(lock, 'wx');
  fs.writeFileSync(handle, JSON.stringify({ ownerPid: process.pid, helperPid: helper.pid, startedAt: Date.now() }));
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${helper.port}/ax`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body)) throw new Error(`AX HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    const elements = [];
    const visit = item => { elements.push(item); for (const child of item.children ?? []) visit(child); };
    body.forEach(visit);
    return { body, elements, app: body[0]?.frame, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') fs.writeFileSync(gate, JSON.stringify({ helperPid: helper.pid, epochMs: Date.now(), reason: 'Client abort does not cancel native AX grid traversal; prevent overlapping retry until task helper reset' }));
    throw error;
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}

export function shownKeyboardFrame(events) {
  const event = events.findLast(row => /^UIKeyboard(?:Will|Did)(?:Show|Hide)Notification$/.test(row.name));
  if (!event || /Hide/.test(event.name)) throw new Error('No currently shown native keyboard frame observation');
  const values = event.endFrame?.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (values?.length !== 4 || values[2] <= 0 || values[3] <= 0) throw new Error('Invalid observed native keyboard frame');
  return { x: values[0], y: values[1], width: values[2], height: values[3], epochMs: event.epochMs };
}

export function systemKeyboardKey(elements, frame, key, optional = false) {
  const matches = elements.filter(n => n.type === 'Button' && n.AXLabel === key && n.enabled !== false && n.frame?.width > 0 && n.frame?.height > 0
    && n.frame.x >= frame.x - 1 && n.frame.y >= frame.y - 1
    && n.frame.x + n.frame.width <= frame.x + frame.width + 1 && n.frame.y + n.frame.height <= frame.y + frame.height + 1);
  if (!matches.length && optional) return null;
  if (matches.length !== 1) throw new Error(`Expected one actual system keyboard key ${JSON.stringify(key)} inside observed native keyboard frame, got ${matches.length}`);
  return matches[0];
}
