import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ context: {}, token: vi.fn(), client: vi.fn() }));
vi.mock('./auth.js', () => ({ getGitHubAuthContext: () => fixture.context }));
vi.mock('./gh-cli-credential.js', () => ({ getGhCliToken: fixture.token }));
vi.mock('@octokit/rest', () => ({ Octokit: class { constructor(options) { fixture.client(options); } } }));
import { getOctokitOrNull } from './octokit.js';
beforeEach(() => { fixture.token.mockReset().mockReturnValue('synthetic-cli'); fixture.client.mockReset(); });

it('does not read CLI credentials or silently select another account after explicit disconnect', () => {
  fixture.context = { explicit: true, selection: null, auth: null, ghCliActive: false, ghCliDisabled: false };
  expect(getOctokitOrNull()).toBeNull(); expect(fixture.token).not.toHaveBeenCalled(); expect(fixture.client).not.toHaveBeenCalled();
});

it('uses one captured authoritative OAuth source without consulting a stale CLI mirror', () => {
  fixture.context = { explicit: true, selection: { source: 'oauth', accountId: 'alpha' }, auth: { accessToken: 'synthetic-oauth' }, ghCliActive: true, ghCliDisabled: false };
  getOctokitOrNull(); expect(fixture.token).not.toHaveBeenCalled(); expect(fixture.client).toHaveBeenCalledWith(expect.objectContaining({ auth: 'synthetic-oauth' }));
});

it('preserves pre-migration implicit CLI fallback, but explicit unavailable CLI never falls back to OAuth', () => {
  fixture.context = { explicit: false, selection: null, auth: null, ghCliActive: false, ghCliDisabled: false };
  getOctokitOrNull(); expect(fixture.client).toHaveBeenCalledWith(expect.objectContaining({ auth: 'synthetic-cli' }));
  fixture.client.mockClear(); fixture.token.mockReturnValue(null);
  fixture.context = { explicit: true, selection: { source: 'gh-cli', accountId: 'gh-cli' }, auth: { accessToken: 'synthetic-oauth' }, ghCliActive: true, ghCliDisabled: false };
  expect(getOctokitOrNull()).toBeNull(); expect(fixture.client).not.toHaveBeenCalled();
});
