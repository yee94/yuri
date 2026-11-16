import { describe, expect, it, vi } from 'vitest';
import { createUnindexedSessionAdopter } from './adopt-unindexed-session.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const setup = (overrides = {}) => {
  const service = {
    findBySessionId: vi.fn(() => null),
    upsertAndReportChange: vi.fn(() => true),
    touchActivity: vi.fn(() => true),
  };
  const deps = {
    service,
    fetchSession: vi.fn(async () => ({ id: 'ses_old', directory: '/repo', time: { created: 1, updated: 2 } })),
    projectSession: vi.fn((session) => ({ ...session, projected: true })),
    onChanged: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
  return { service, deps, adopt: createUnindexedSessionAdopter(deps) };
};

describe('createUnindexedSessionAdopter', () => {
  it('writes the projected upstream session and advances activity to the user message', async () => {
    const { service, deps, adopt } = setup();
    adopt('ses_old', '/repo', 900);
    await flush();
    expect(deps.fetchSession).toHaveBeenCalledWith({ sessionID: 'ses_old', directory: '/repo' });
    expect(service.upsertAndReportChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ses_old', projected: true, time: { created: 1, updated: 900 } }),
      expect.any(Number),
    );
    expect(service.touchActivity).toHaveBeenCalledWith('ses_old', 900);
    expect(deps.onChanged).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of messages into one upstream read', async () => {
    const { deps, adopt } = setup();
    adopt('ses_old', '', 1);
    adopt('ses_old', '', 2);
    await flush();
    expect(deps.fetchSession).toHaveBeenCalledTimes(1);
    expect(deps.fetchSession).toHaveBeenCalledWith({ sessionID: 'ses_old', directory: null });
  });

  it('writes nothing when Host metadata is unavailable or the session is missing upstream', async () => {
    const unavailable = setup({ projectSession: vi.fn(() => null) });
    unavailable.adopt('ses_old', '/repo', 1);
    const missing = setup({ fetchSession: vi.fn(async () => null) });
    missing.adopt('ses_old', '/repo', 1);
    await flush();
    expect(unavailable.service.upsertAndReportChange).not.toHaveBeenCalled();
    expect(missing.service.upsertAndReportChange).not.toHaveBeenCalled();
    expect(unavailable.deps.onChanged).not.toHaveBeenCalled();
  });

  it('keeps a live-written row instead of overwriting it with the upstream read', async () => {
    const { service, adopt } = setup();
    service.findBySessionId.mockReturnValue({ id: 'ses_old' });
    adopt('ses_old', '/repo', 1);
    await flush();
    expect(service.upsertAndReportChange).not.toHaveBeenCalled();
  });

  it('reports a failed fetch and allows a later message to retry', async () => {
    const fetchSession = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ id: 'ses_old', directory: '/repo', time: {} });
    const { service, deps, adopt } = setup({ fetchSession });
    adopt('ses_old', '/repo', 1);
    await flush();
    expect(deps.warn).toHaveBeenCalledTimes(1);
    adopt('ses_old', '/repo', 2);
    await flush();
    expect(service.upsertAndReportChange).toHaveBeenCalledTimes(1);
  });
});
