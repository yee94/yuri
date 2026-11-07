import { expect, it } from 'vitest';
import { createDeviceFlowSessions } from './device-flow-sessions.js';

it('cancels a pending exchange and refuses its late commit without pretending to revoke provider tokens', () => {
  const sessions = createDeviceFlowSessions();
  sessions.issue('synthetic-code', 60);
  const flight = sessions.begin('synthetic-code');
  expect(sessions.cancel('synthetic-code')).toEqual({ cancelled: true, status: 'cancelled', providerRevoked: false });
  let committed = false;
  expect(sessions.commit(flight, () => { committed = true; return { connected: true }; })).toMatchObject({ connected: false, status: 'access_denied' });
  expect(committed).toBe(false);
  expect(sessions.begin('synthetic-code').result).toMatchObject({ connected: false, status: 'access_denied' });
});

it('has bounded expiry/capacity and returns a safe receipt rather than repeating an acknowledged exchange', () => {
  let time = 0;
  const sessions = createDeviceFlowSessions({ now: () => time, limit: 1 });
  sessions.issue('synthetic-code', 2);
  const flight = sessions.begin('synthetic-code');
  const result = { connected: true, user: { login: 'synthetic' } };
  expect(sessions.commit(flight, () => result)).toBe(result);
  expect(sessions.begin('synthetic-code').result).toBe(result);
  expect(sessions.cancel('synthetic-code')).toEqual({ cancelled: false, status: 'complete', providerRevoked: false });
  expect(() => sessions.issue('another-synthetic-code', 2)).toThrow();
  time = 62_001; sessions.issue('another-synthetic-code', 1); time += 1001;
  expect(sessions.begin('another-synthetic-code').result).toMatchObject({ connected: false, status: 'expired_token' });
  expect(() => sessions.begin('unissued-synthetic-code')).toThrow();
});

it('does not claim successful cancellation after an uncertain Host credential commit', () => {
  const sessions = createDeviceFlowSessions(); sessions.issue('synthetic-code', 60); const flight = sessions.begin('synthetic-code');
  expect(() => sessions.commit(flight, () => { throw new Error('synthetic uncertain write'); })).toThrow();
  sessions.fail(flight);
  expect(sessions.cancel('synthetic-code')).toEqual({ cancelled: false, status: 'unknown', providerRevoked: false });
});
