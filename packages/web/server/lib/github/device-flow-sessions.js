import { createHash } from 'node:crypto';

const unavailable = () => Object.assign(new Error('GitHub device flow is unavailable'), { status: 410, code: 'github_device_flow_unavailable' });

/** Host-local admission for the existing device-code handshake, never an OAuth token store. */
export function createDeviceFlowSessions({ now = Date.now, limit = 128 } = {}) {
  const sessions = new Map();
  const key = code => {
    if (typeof code !== 'string' || !code.trim() || code.length > 4096) throw unavailable();
    return createHash('sha256').update(code).digest('hex');
  };
  function prune() { for (const [id, value] of sessions) if (value.deadline + 60_000 <= now()) sessions.delete(id); }
  function terminal(value) {
    if (value.phase === 'complete') return value.result;
    if (value.phase === 'cancelled') return { connected: false, status: 'access_denied', error: 'Device authorization cancelled on this Host' };
    if (value.phase === 'failed' || value.phase === 'unknown' || value.deadline <= now()) return { connected: false, status: 'expired_token', error: 'Device authorization is no longer available' };
    return null;
  }
  function current(flight) { return sessions.get(flight.key) === flight && flight.phase === 'exchanging' && !terminal(flight); }
  return {
    issue(code, expiresIn) {
      prune();
      if (sessions.size >= limit) throw Object.assign(new Error('Too many GitHub device flows'), { status: 429, code: 'github_device_flow_capacity' });
      if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 1800) throw unavailable();
      const id = key(code);
      // Reissued codes must not revive an earlier cancelled or consumed authorization.
      if (sessions.has(id)) throw unavailable();
      sessions.set(id, { key: id, deadline: now() + expiresIn * 1000, phase: 'pending', result: null });
    },
    begin(code) {
      prune(); const flight = sessions.get(key(code)); if (!flight) throw unavailable();
      const result = terminal(flight); if (result) return { result };
      if (flight.phase !== 'pending') throw Object.assign(new Error('GitHub exchange already in progress'), { status: 409, code: 'github_device_flow_busy' });
      flight.phase = 'exchanging'; return flight;
    },
    current,
    pending(flight, result) {
      if (!current(flight)) return terminal(flight) ?? { connected: false, status: 'expired_token' };
      flight.phase = ['authorization_pending', 'slow_down'].includes(result.status) ? 'pending' : 'failed';
      return result;
    },
    commit(flight, write) {
      if (!current(flight)) return terminal(flight) ?? { connected: false, status: 'expired_token' };
      // No await between final admission and synchronous auth commit.
      try { const result = write(); flight.result = result; flight.phase = 'complete'; return result; }
      catch (error) { flight.phase = 'unknown'; throw error; }
    },
    fail(flight) { if (current(flight)) flight.phase = 'failed'; },
    cancel(code) {
      prune(); const value = sessions.get(key(code));
      if (!value) return { cancelled: false, status: 'unavailable', providerRevoked: false };
      if (value.phase === 'complete') return { cancelled: false, status: 'complete', providerRevoked: false };
      if (value.phase === 'unknown') return { cancelled: false, status: 'unknown', providerRevoked: false };
      value.phase = 'cancelled'; value.result = null;
      return { cancelled: true, status: 'cancelled', providerRevoked: false };
    },
  };
}
