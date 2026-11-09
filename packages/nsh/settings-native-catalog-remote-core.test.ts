import { describe, expect, it, vi } from 'vitest';
import { mergeNativeCatalogItems, nativeCatalogFailure, nativeCatalogPage, nativeCatalogSourcePath, nativeCatalogSources, nativeSkillCatalogPatch, nativeSkillInstall, type NativeCatalogSkill } from './settings-skills-catalog-core';
import { nativePairingLink, nativePairingRequest, nativePairingTransports, nativePendingPairings, nativeRemoteClients } from './settings-remote-instances-core';
import { parsePairingConnectionPayloadString } from '../ui/src/lib/connectionPayload';

const skill: NativeCatalogSkill = { sourceId: 'curated', repoSource: 'https://example.invalid/team/skills', repoSubpath: 'tools', skillDir: '', skillName: 'root-skill', installable: true, gitIdentityId: 'metadata-only' };
describe('native Skill catalog Host wire', () => {
  it('distinguishes successful empty snapshots from malformed/failure envelopes', () => {
    expect(nativeCatalogSources({ ok: true, sources: [] })).toEqual([]);
    expect(nativeCatalogPage({ ok: true, items: [] }, 'curated')).toEqual({ items: [], cursor: null });
    for (const value of [null, [], {}, { ok: false, sources: [] }, { sources: [null] }]) expect(() => nativeCatalogSources(value)).toThrow();
    for (const value of [{}, { ok: false, items: [] }, { items: [skill], nextCursor: 7 }, { items: [{ ...skill, sourceId: 'other' }] }, { items: [{ ...skill, installable: 'yes' }] }]) expect(() => nativeCatalogPage(value, 'curated')).toThrow();
  });
  it('preserves opaque cursors and exact directory without decoding or guessing', () => {
    const path = nativeCatalogSourcePath('custom:a/b', '/workspace/two', { cursor: 'opaque/+=?&中文' });
    const query = new URL(path, 'https://fixture.invalid').searchParams;
    expect(query.get('sourceId')).toBe('custom:a/b'); expect(query.get('cursor')).toBe('opaque/+=?&中文'); expect(query.get('directory')).toBe('/workspace/two');
  });
  it('deduplicates pages in server order and replaces existing identities in place', () => {
    const first = { ...skill, skillDir: 'z' }, second = { ...skill, skillDir: 'a' }, updated = { ...first, description: 'fresh' };
    expect(mergeNativeCatalogItems([first, second], [updated, { ...skill, skillDir: 'm' }])).toEqual([updated, second, { ...skill, skillDir: 'm' }]);
    expect(first.description).toBeUndefined();
  });
  it.each(['user-opencode', 'project-opencode', 'user-agents', 'project-agents'])('builds %s using the actual directory and a narrow selection', location => {
    const request = nativeSkillInstall(skill, location, '/workspace/selected');
    expect(request.body.scope).toBe(location.startsWith('project') ? 'project' : 'user');
    expect(request.body.targetSource).toBe(location.endsWith('agents') ? 'agents' : 'opencode');
    expect(request.body.selections).toEqual([{ skillDir: '' }]);
    expect(request.body.gitIdentityId).toBe('metadata-only'); expect(request.body.conflictPolicy).toBe('prompt');
    expect(request.path.includes('directory=')).toBe(location.startsWith('project'));
    if (location.startsWith('project')) expect(new URL(request.path, 'https://fixture.invalid').searchParams.get('directory')).toBe('/workspace/selected');
  });
  it('rejects unavailable locations and missing project authority; passes version metadata', () => {
    expect(() => nativeSkillInstall(skill, 'project-agents')).toThrow();
    expect(() => nativeSkillInstall(skill, 'user-claude')).toThrow();
    expect(() => nativeSkillInstall({ ...skill, installable: false }, 'user-agents')).toThrow();
    expect(nativeSkillInstall({ ...skill, clawdhub: { slug: 's', version: '2', downloads: 500 } }, 'user-agents').body.selections).toEqual([{ skillDir: '', clawdhub: { slug: 's', version: '2' } }]);
  });
  it('retains structured 401 auth and 409 per-skill conflict metadata', () => {
    expect(nativeCatalogFailure({ status: 401, body: { ok: false, error: { kind: 'authRequired', identities: [{ id: 'key', name: 'Team', privateKey: 'must-not-project' }] } } })).toEqual({ kind: 'authRequired', identities: [{ id: 'key', name: 'Team' }], conflicts: [] });
    expect(nativeCatalogFailure({ status: 409, body: { ok: false, error: { kind: 'conflicts', conflicts: [{ skillName: 'one', scope: 'project', source: 'agents' }] } } })?.conflicts).toEqual([{ skillName: 'one', scope: 'project', source: 'agents' }]);
    expect(nativeCatalogFailure({ status: 200, body: { ok: true } })).toBeNull();
    expect(nativeCatalogFailure({ status: 503, body: 'unavailable' })?.kind).toBe('unknown');
  });
  it('patches the latest custom collection without dropping unknown fields or unrelated concurrent additions', () => {
    const concurrent = { id: 'custom:other', source: 'other/repo', label: 'Other', future: { retained: true } };
    const entry = { id: 'custom:new', source: 'team/repo', label: 'Team' };
    const patched = nativeSkillCatalogPatch({ unrelated: 3, skillCatalogs: [concurrent] }, { add: entry });
    expect(patched).toEqual({ skillCatalogs: [concurrent, entry] });
    expect(nativeSkillCatalogPatch(patched, { add: entry })).toEqual(patched);
    expect(nativeSkillCatalogPatch(patched, { remove: entry.id })).toEqual({ skillCatalogs: [concurrent] });
    expect(() => nativeSkillCatalogPatch(patched, { add: { ...entry, source: 'hijacked/repo' } })).toThrow();
    expect(() => nativeSkillCatalogPatch(patched, { remove: 'curated' })).toThrow();
  });
});

const client = { id: 'desktop', label: 'Desktop', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null };
const transports = { local: 'http://localhost:3000', lan: 'http://192.0.2.10:3000', relayAvailable: true, relayUrl: 'wss://relay.example.invalid/ws' };
describe('native remote devices and one-time pairing wire', () => {
  it('uses only connected as presence and never includes credentials in list projections', () => {
    const result = nativeRemoteClients({ clients: [{ ...client, usesRelay: true, token: 'synthetic-only', secret: 'synthetic-only' }], currentClientId: 'desktop' });
    expect(result.clients[0].connected).toBeUndefined(); expect(result.currentClientId).toBe('desktop');
    expect(result.clients[0]).not.toHaveProperty('token'); expect(result.clients[0]).not.toHaveProperty('secret');
    expect(nativeRemoteClients({ clients: [] })).toEqual({ clients: [], currentClientId: null });
    expect(() => nativeRemoteClients({ clients: [{ ...client, connected: 'true' }] })).toThrow();
    expect(() => nativeRemoteClients({})).toThrow();
  });
  it('reads the real pending envelope, strips secrets, and rejects bare arrays/failures', () => {
    expect(nativePendingPairings({ pending: [{ id: 'pending', secret: 'synthetic-only', label: 'Phone' }] })).toEqual([{ id: 'pending', label: 'Phone' }]);
    for (const value of [[], {}, null, { ok: false, pending: [] }]) expect(() => nativePendingPairings(value)).toThrow();
  });
  it('accepts unavailable nullable relay, rejects credentials and malformed endpoints', () => {
    expect(nativePairingTransports({ local: null, lan: null, relayAvailable: false, relayUrl: null })).toEqual({ local: null, lan: null, relayAvailable: false });
    expect(() => nativePairingTransports({ ...transports, relayUrl: 'wss://user:password@relay.example.invalid/ws' })).toThrow();
    expect(() => nativePairingTransports({ ...transports, local: undefined })).toThrow();
  });
  it.each(['local', 'lan', 'relay'] as const)('honors %s transport and explicit fallback', transport => {
    const draft = { label: '  Test  ', transport, fallback: false, relayUrl: transports.relayUrl };
    const request = nativePairingRequest(draft, transports);
    expect(request.label).toBe('Test'); expect(request.allowedClientKinds).toEqual(['mobile', 'desktop']);
    expect(request.includeRelay).toBe(transport === 'relay'); expect(request.includeDirect).toBe(transport !== 'relay');
    if (transport === 'local') expect(request.serverUrl).toBe(transports.local);
    if (transport === 'lan') expect(request.serverUrl).toBe(transports.lan);
    if (transport === 'relay') expect(nativePairingRequest({ ...draft, fallback: true }, transports).serverUrl).toBe(transports.lan);
  });
  it('enforces locked Host relay and unavailable transport in the core', () => {
    const draft = { label: '', transport: 'relay' as const, fallback: false, relayUrl: 'wss://override.example.invalid/ws' };
    expect(nativePairingRequest(draft, { ...transports, relayUrlLocked: true }).relayUrl).toBe(transports.relayUrl);
    expect(() => nativePairingRequest(draft, { ...transports, relayAvailable: false })).toThrow();
    expect(() => nativePairingRequest({ ...draft, transport: 'lan' }, { ...transports, lan: null })).toThrow();
  });
  it('round-trips the existing v2 encoder including a public relay trust anchor', () => {
    const result = nativePairingLink({ pairing: { id: 'once', secret: 'synthetic-one-time', expiresAt: '2099-01-01T00:00:00Z' }, server: { candidates: [{ type: 'lan', url: transports.lan }, { type: 'relay', relayUrl: transports.relayUrl, serverId: 'server', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } }] } }, '测试设备');
    expect(result.id).toBe('once'); expect(result.url).not.toContain('synthetic-one-time');
    expect(parsePairingConnectionPayloadString(result.url)).toMatchObject({ v: 2, label: '测试设备', secret: 'synthetic-one-time', candidates: [{ type: 'lan' }, { type: 'relay', serverId: 'server' }] });
    expect(() => nativePairingLink({ pairing: { id: 'x', secret: 'x' }, server: { candidates: [] } }, '')).toThrow();
  });
  it('keeps the v2 wire identical with a base64-only native Buffer and browser encoding', () => {
    const input = { pairing: { id: 'once', secret: 'synthetic-only' }, server: { candidates: [{ type: 'lan', url: transports.lan }] } };
    const reference = nativePairingLink(input, '跨端 🟢').url, nativeBuffer = globalThis.Buffer;
    const encodings: string[] = [];
    try {
      vi.stubGlobal('Buffer', { from(value: string, encoding: BufferEncoding) {
        encodings.push(encoding); if (encoding === 'base64url') throw new Error('Unsupported encoding');
        const bytes = nativeBuffer.from(value, encoding);
        return { toString(output: BufferEncoding) { encodings.push(output); if (output === 'base64url') throw new Error('Unsupported encoding'); return bytes.toString(output); } };
      } });
      expect(nativePairingLink(input, '跨端 🟢').url).toBe(reference);
      expect(parsePairingConnectionPayloadString(reference)?.label).toBe('跨端 🟢');
      expect(encodings).not.toContain('base64url');
      vi.stubGlobal('Buffer', undefined);
      expect(nativePairingLink(input, '跨端 🟢').url).toBe(reference);
      expect(parsePairingConnectionPayloadString(reference)?.label).toBe('跨端 🟢');
    } finally { vi.unstubAllGlobals(); }
  });
});
