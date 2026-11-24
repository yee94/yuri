import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  contactHistoryForLlm,
  contactLlmWindow,
  ensureContactSchema,
  insertContactMessage,
  nextContactOrdinal,
  projectActiveContactTurns,
} from './contact-store.js';
import { runContactTurn } from './harness.js';
import { createAssistantsService } from './service.js';

const require = createRequire(import.meta.url);

const openDb = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-provenance-'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(directory, 'contact.sqlite'));
  ensureContactSchema(db);
  return db;
};

const addRow = (db, assistantID, { messageID, role, turnID, text, createdAt = Date.now() }) => {
  const ordinal = nextContactOrdinal(db, assistantID);
  insertContactMessage(db, {
    messageID,
    assistantID,
    role,
    turnID,
    bubbleIndex: 0,
    createdAt,
    ordinal,
    status: 'complete',
    parts: [{ type: 'text', text }],
  });
  return ordinal;
};

describe('Issue #223 contact history provenance, queue exposure, and turn trace', () => {
  it('reproduces #223 ordinals 1..7: preserves late prior reply with provenance, blocks future turn assistant leaks, and attributes interleaved replies', () => {
    const db = openDb();
    try {
      const assistantID = 'asst_223';
      const oct27 = Date.UTC(2026, 9, 27, 11, 55, 0);
      const nov24 = Date.UTC(2026, 10, 24, 4, 44, 53);

      addRow(db, assistantID, { messageID: 'A', role: 'user', turnID: 'A', text: 'Watch old deployment ALPHA.', createdAt: oct27 });
      addRow(db, assistantID, { messageID: 'A:b1', role: 'assistant', turnID: 'A', text: 'I will monitor ALPHA.', createdAt: oct27 + 60_000 });
      addRow(db, assistantID, { messageID: 'B', role: 'user', turnID: 'B', text: 'Edit routing policy BETA.', createdAt: nov24 });
      const ordinalC = addRow(db, assistantID, { messageID: 'C', role: 'user', turnID: 'C', text: 'Continue.', createdAt: nov24 + 469_000 });
      addRow(db, assistantID, { messageID: 'B:b1', role: 'assistant', turnID: 'B', text: 'BETA v1 edited.', createdAt: nov24 + 471_000 });
      const ordinalD = addRow(db, assistantID, { messageID: 'D', role: 'user', turnID: 'D', text: 'Correction: keep architecture work in the main agent.', createdAt: nov24 + 555_000 });

      // C runs before D: includes B's late reply 5 (marked delivered-after-current-user),
      // includes immutable cross-day date transition on B, and excludes D.
      const windowC = contactLlmWindow(db, assistantID, {
        beforeOrdinal: ordinalC,
        excludeMessageIDs: ['C'],
      });
      expect(windowC.includedOrdinals).toEqual([1, 2, 3, 5]);
      expect(windowC.items).toHaveLength(4);
      expect(windowC.items[0]).toEqual({ role: 'user', content: 'Watch old deployment ALPHA.' });
      expect(windowC.items[1]).toEqual({ role: 'assistant', content: 'I will monitor ALPHA.' });
      expect(windowC.items[2].role).toBe('user');
      expect(windowC.items[2].content).toContain('[Yuri conversation date: 2026-11-24; previous message was on 2026-10-27.]');
      expect(windowC.items[2].content).toContain('Edit routing policy BETA.');
      expect(windowC.items[3].role).toBe('assistant');
      expect(windowC.items[3].content).toContain('[Yuri reply provenance: assistant reply to earlier user message (turnID="B", user="Edit routing policy BETA."); delivered after the current user message was sent');
      expect(windowC.items[3].content).toContain('BETA v1 edited.');

      // C publishes its late reply at ordinal 7 after D (ordinal 6).
      addRow(db, assistantID, { messageID: 'C:b1', role: 'assistant', turnID: 'C', text: 'ALPHA finished.', createdAt: nov24 + 1_133_000 });
      // Also verify a hypothetical assistant reply belonging to D (ordinal > ordinalC) is never leaked into C.
      addRow(db, assistantID, { messageID: 'D:b1', role: 'assistant', turnID: 'D', text: 'D reply should not leak into C.', createdAt: nov24 + 1_200_000 });

      const windowCAfter = contactLlmWindow(db, assistantID, {
        beforeOrdinal: ordinalC,
        excludeMessageIDs: ['C'],
      });
      expect(windowCAfter.items.map((item) => item.content).join('\n')).not.toContain('D reply should not leak into C.');

      // D runs after C's late reply at ordinal 7: sees B's interleaved reply 5 attributed to B
      // and C's late reply 7 attributed to C (not D).
      const historyD = contactHistoryForLlm(db, assistantID, {
        beforeOrdinal: ordinalD,
        excludeMessageIDs: ['D', 'D:b1'],
      });
      expect(historyD).toHaveLength(6);
      expect(historyD[4].role).toBe('assistant');
      expect(historyD[4].content).toContain('turnID="B"');
      expect(historyD[4].content).toContain('not a reply to later user messages');
      expect(historyD[5].role).toBe('assistant');
      expect(historyD[5].content).toContain('turnID="C"');
      expect(historyD[5].content).toContain('delivered after the current user message was sent');
      expect(historyD[5].content).toContain('ALPHA finished.');
    } finally {
      db.close();
    }
  });

  it('orders all active contact turns via projectActiveContactTurns', () => {
    expect(projectActiveContactTurns([
      { turnID: 'turn_queued_2', messageID: 'turn_queued_2', status: 'queued', admittedAt: 30 },
      { turnID: 'turn_running', messageID: 'turn_running', status: 'running', admittedAt: 10 },
      { turnID: 'turn_queued_1', messageID: 'turn_queued_1', status: 'queued', admittedAt: 20 },
    ])).toEqual([
      { turnID: 'turn_running', messageID: 'turn_running', status: 'running', admittedAt: 10 },
      { turnID: 'turn_queued_1', messageID: 'turn_queued_1', status: 'queued', admittedAt: 20 },
      { turnID: 'turn_queued_2', messageID: 'turn_queued_2', status: 'queued', admittedAt: 30 },
    ]);
  });

  it('exposes full activeContactTurns queue in snapshot and emits sanitized per-turn trace without message content', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-queue-trace-'));
    const traces = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const service = createAssistantsService({
      dbPath: path.join(dir, 'assistants.sqlite'),
      dataDir: dir,
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      onContactTurnTrace: (trace) => traces.push(trace),
      runContactTurn: async ({ userText, onTurnTrace }) => {
        if (userText === 'secret-first-prompt') await firstGate;
        onTurnTrace?.({
          completionCalls: [{ attempt: 0, durationMs: 12, toolCallNames: ['list_sessions'], hasText: true, protocolError: false }],
          toolCalls: [{ name: 'list_sessions', durationMs: 5, isError: false }],
        });
        return { text: `done:${userText}`, bubbles: [`done:${userText}`], cards: [] };
      },
    });
    try {
      service.setEnabled({ enabled: true, expectedRevision: service.snapshot().revision });
      const created = service.createAssistant({
        name: 'TraceBot',
        providerID: 'p',
        modelID: 'm',
        defaultPrompt: '',
        mode: 'continuous',
      });
      const assistantID = created.id;

      await service.send(assistantID, { messageID: 'turn_1', parts: [{ type: 'text', text: 'secret-first-prompt' }] });
      await new Promise((resolve) => setTimeout(resolve, 15));
      await service.send(assistantID, { messageID: 'turn_2', parts: [{ type: 'text', text: 'secret-correction-prompt' }] });

      const midSnap = service.snapshot().assistants.find((item) => item.id === assistantID);
      expect(midSnap.working).toBe(true);
      expect(midSnap.activeContactTurn).toMatchObject({ turnID: 'turn_1', status: 'running' });
      expect(midSnap.activeContactTurns).toMatchObject([
        { turnID: 'turn_1', messageID: 'turn_1', status: 'running' },
        { turnID: 'turn_2', messageID: 'turn_2', status: 'queued' },
      ]);

      releaseFirst();
      await service.whenContactTurnSettled('turn_1');
      await service.whenContactTurnSettled('turn_2');

      expect(traces).toHaveLength(2);
      expect(traces[0]).toMatchObject({
        assistantID,
        turnID: 'turn_1',
        status: 'complete',
        toolCalls: [{ name: 'list_sessions', durationMs: 5, isError: false }],
      });
      expect(traces[1]).toMatchObject({
        assistantID,
        turnID: 'turn_2',
        status: 'complete',
        historyTurnIDs: expect.arrayContaining(['turn_1']),
      });
      const serialized = JSON.stringify(traces);
      expect(serialized).not.toContain('secret-first-prompt');
      expect(serialized).not.toContain('secret-correction-prompt');
    } finally {
      service.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes continuation disambiguation guardrails in the contact system prompt', async () => {
    const completion = vi.fn(async () => ({ text: 'Confirmed.' }));
    await runContactTurn({
      assistant: { id: 'a', name: 'Helper', providerID: 'p', modelID: 'm', defaultPrompt: '' },
      history: [],
      userText: 'Continue.',
      createChatCompletion: completion,
    });
    const systemPrompt = completion.mock.calls[0][0].body.messages[0].content;
    expect(systemPrompt).toContain('Ambiguous continuations');
    expect(systemPrompt).toContain('without explicit user confirmation');
    expect(systemPrompt).toContain('Clearly distinguish historical records');
  });
});
