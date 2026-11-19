import { describe, expect, it } from 'bun:test';
import { createOpenCodeSessionId, fetchOpenCodeGoKeyUsage, fetchOpenCodeGoUsage, parseOpenCodeGoKeyUsage, parseOpenCodeGoUsage } from './opencode-go.js';

describe('OpenCode Go quota provider', () => {
  it('reads key usage windows and drops the placeholder reset of an idle window', () => {
    const windows = parseOpenCodeGoKeyUsage({ usage: {
      rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-25T20:00:00.000Z' },
      weekly: { status: 'ok', percent: 62, resetsAt: '2026-09-28T00:00:00.000Z' },
      monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-11T00:00:00.000Z' },
    } });
    expect(windows['5h'].usedPercent).toBe(0);
    expect(windows['5h'].resetAt).toBeNull();
    expect(windows.weekly.usedPercent).toBe(62);
    expect(windows.weekly.resetAt).toBe(Date.parse('2026-09-28T00:00:00.000Z'));
    expect(windows.monthly.usedPercent).toBe(100);
    expect(parseOpenCodeGoKeyUsage({ rollingUsage: {} })).toEqual({});
  });

  it('sends the key with a session and explains refused keys without echoing it', async () => {
    let headers;
    const ok = await fetchOpenCodeGoKeyUsage('sk-secret', async (_url, init) => {
      headers = init.headers;
      return Response.json({ usage: { weekly: { percent: 10, resetsAt: '2026-09-28T00:00:00.000Z' } } });
    });
    expect(headers.Authorization).toBe('Bearer sk-secret');
    expect(headers['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(ok.weekly.usedPercent).toBe(10);
    await expect(fetchOpenCodeGoKeyUsage('sk-secret', async () => new Response('', { status: 403 }))).rejects.toThrow('no OpenCode Go subscription');
    await expect(fetchOpenCodeGoKeyUsage('sk-secret', async () => new Response('', { status: 401 }))).rejects.toThrow('did not accept');
    await expect(fetchOpenCodeGoKeyUsage('sk-secret', async () => Response.json({ usage: { fiveHour: { used: 3 } } }))).rejects.toThrow('could not be parsed');
    expect(createOpenCodeSessionId()).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it('parses partial SSR usage windows in either field order', () => {
    const windows = parseOpenCodeGoUsage('rollingUsage:$R[1]={usagePercent:25,resetInSec:60} weeklyUsage:$R[2]={resetInSec:120,usagePercent:40}', 1_000);
    expect(windows['5h'].usedPercent).toBe(25);
    expect(windows['5h'].resetAt).toBe(61_000);
    expect(windows.weekly.usedPercent).toBe(40);
    expect(windows.monthly).toBeUndefined();
  });

  it('does not expose credentials in authentication errors', async () => {
    const credential = { workspaceId: 'wrk_test', authCookie: 'secret' };
    await expect(fetchOpenCodeGoUsage(credential, async () => new Response('', { status: 403 }))).rejects.toThrow('authentication failed');
  });
});
