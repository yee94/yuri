import { expect, test } from 'vitest';
import { materializeSessionMentionTokens, serializeComposerDocument } from './document';
import { compileComposerSendPlan } from './send-plan';
import { composerTriggerIconDisplay } from './inline-visual';
import { parseDraftComposerDocument } from '@/sync/input-draft-types';
import { buildComposerSemanticParts, ensureSessionMentionTranscripts } from './delivery';

test('session scope survives durable sidecars, canonical materialization and direct-send semantics', () => {
    const target = { hubId: 'hub', hostId: 'a', instanceId: 'instance-a' };
    const directory = '/a "quoted"/中文/} spaced';
    const display = composerTriggerIconDisplay({ trigger: '@', icon: 'chat-thread', label: 'Remote title' });
    const reference = { id: 'ref', kind: 'session' as const, sessionId: 'same', directory, target, display, start: 0, end: display.length };
    const durable = parseDraftComposerDocument(display, JSON.parse(JSON.stringify([reference])))!;
    expect(durable.references[0]).toEqual(reference);
    const canonical = serializeComposerDocument(durable);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) throw new Error('serialize failed');
    expect(canonical.text).toContain('"target":{"hubId":"hub","hostId":"a","instanceId":"instance-a"}');
    const restored = materializeSessionMentionTokens(canonical.text, new Map([['same', 'HUB TITLE']]));
    expect(restored.references[0]).toMatchObject({ sessionId: 'same', directory, target });
    expect(restored.text).not.toContain('HUB TITLE');
    expect(serializeComposerDocument(restored)).toMatchObject({ ok: true, text: canonical.text });
    expect(compileComposerSendPlan(restored, 'direct-send-display')).toMatchObject({ ok: true, plan: { semantics: [{ type: 'session', sessionId: 'same', directory, target }] } });
});

test.each([null, {}, { hubId: 'hub', hostId: 'a' }, { hubId: 'hub', hostId: 'a', instanceId: '' }])('malformed present target is rejected rather than stripped: %j', (target) => {
    const reference = { id: 'ref', kind: 'session', sessionId: 'same', directory: '/same', target, display: '@same', start: 0, end: 5 };
    expect(parseDraftComposerDocument('@same', [reference])).toBeUndefined();
    expect(serializeComposerDocument({ text: '@same', references: [reference] } as never)).toMatchObject({ ok: false });
    const malformed = `@session:${JSON.stringify({ sessionID: 'same', directory: '/same', target })}`;
    expect(materializeSessionMentionTokens(malformed, new Map()).references).toEqual([]);
});

test('legacy local canonical bytes stay compatible; remote references cannot enter local transcript delivery', async () => {
    const local = materializeSessionMentionTokens('@session:same', new Map([['same', 'Local']]));
    expect(serializeComposerDocument(local)).toMatchObject({ ok: true, text: '@session:same' });
    const semantics = [{ type: 'session' as const, sessionId: 'same', directory: '/same', target: { hubId: 'hub', hostId: 'a', instanceId: 'instance-a' } }];
    expect(() => buildComposerSemanticParts(semantics, '/same')).toThrow('Host delivery');
    await expect(ensureSessionMentionTranscripts(semantics, '/same')).rejects.toThrow('Host delivery');
});
