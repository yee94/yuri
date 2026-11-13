import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerRemoteConnectionsSkill, REMOTE_CONNECTIONS_SKILL_PATH } from './remote-connections.js';

describe('remote connection bridge availability', () => {
  const auth = { Authorization: `Basic ${Buffer.from('opencode:fixture').toString('base64')}` };
  it.each([true, false])('has no native capability outside a shared desktop: shared=%s', async (shared) => {
    const app = express();
    const createClient = vi.fn();
    registerRemoteConnectionsSkill(app, { express, adapter: null,
      getIsSharedOpenCodeService: () => shared, getOpenCodeAuthHeaders: () => auth, createClient });
    const response = await request(app).post(REMOTE_CONNECTIONS_SKILL_PATH).set(auth).send({ sessionID: 'ses_one', operation: 'list' });
    expect(response.status).toBe(shared ? 501 : 403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('never resolves a session or native adapter for a browser-origin request', async () => {
    const app = express();
    const createClient = vi.fn();
    const adapter = { list: vi.fn() };
    registerRemoteConnectionsSkill(app, { express, adapter, getIsSharedOpenCodeService: () => true,
      getOpenCodeAuthHeaders: () => auth, createClient });
    const response = await request(app).post(REMOTE_CONNECTIONS_SKILL_PATH).set(auth)
      .set('Origin', 'http://127.0.0.1').send({ sessionID: 'ses_one', operation: 'list' });
    expect(response.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
    expect(adapter.list).not.toHaveBeenCalled();
  });
});
