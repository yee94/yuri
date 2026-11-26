import { describe, expect, test } from 'vitest';
import { normalizeSessionProjectionPage, reconcileFetched } from '@/sync/session-projection-api';
import { materializeSessionSnapshots } from '@/sync/materialization';
import { resolveSessionMergeStrategy } from '@/sync/session-merge-strategy';
import { applyTranscriptDirectoryEvent, type TranscriptEventDraft } from '@/sync/transcript-event-reducer';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

const makeUser = (id: string, created: number, text = 'prompt'): ChatMessageEntry => ({
    info: {
        id,
        sessionID: 'ses_1',
        role: 'user',
        time: { created },
    },
    parts: [
        {
            id: `${id}:text:0`,
            sessionID: 'ses_1',
            messageID: id,
            type: 'text',
            text,
        },
    ],
});

test('unrelated streaming frames do not re-read completed workspace edit metadata', () => {
    let metadataReads = 0;
    const history = Array.from({ length: 100 }, (_, index) => {
        const assistant = makeAssistant(`history-a-${index}`, index, {
            finish: 'stop',
            completed: index,
            turnIdle: { id: `idle-${index}`, outcome: 'succeeded' },
        });
        assistant.parts = Array.from({ length: 20 }, (_, file): ChatMessageEntry['parts'][number] => ({
            id: `edit-${index}-${file}`,
            sessionID: assistant.info.sessionID,
            messageID: assistant.info.id,
            type: 'tool',
            tool: 'edit',
            callID: `call-${index}-${file}`,
            state: {
                status: 'completed',
                input: {},
                get metadata() {
                    metadataReads += 1;
                    return { filediff: { file: `/side/file-${file}.ts`, additions: 1, deletions: 1 } };
                },
            },
        }));
        return [makeUser(`history-u-${index}`, index), assistant];
    }).flat();
    const options = {
        showTurnChangedFiles: true,
        sessionDirectory: '/main',
        workspaceDirectories: ['/main', '/side', '/third'],
    };
    const liveUser = makeUser('live-u', 100);
    const liveAssistant = makeAssistant('live-a', 101);
    let projection = projectTurnRecords(history, options);
    const firstTurn = projection.turns[0];
    expect(firstTurn?.turnWorkspaceChanges).toHaveLength(20);
    expect(metadataReads).toBeGreaterThanOrEqual(2_000);

    metadataReads = 0;
    for (let frame = 0; frame < 50; frame += 1) {
        const streaming = { ...liveAssistant, parts: makeUser('live-text', 101, 'a'.repeat(frame)).parts };
        projection = projectTurnRecords([...history, liveUser, streaming], { ...options, previousProjection: projection });
    }
    expect(metadataReads).toBe(0);
    expect(projection.turns[0]).toBe(firstTurn);

    const changedScope = projectTurnRecords(history, {
        ...options,
        workspaceDirectories: ['/main', '/third'],
        previousProjection: projection,
    });
    expect(changedScope.turns[0]?.turnWorkspaceChanges).toBeUndefined();
});

const makeAssistant = (
    id: string,
    created: number,
    options: {
        finish?: string;
        completed?: number;
        error?: unknown;
        files?: string[];
        start?: string;
        end?: string;
        turnIdle?: { id?: string; outcome: 'succeeded' | 'failed' | 'interrupted' };
    } = {},
): ChatMessageEntry => ({
    info: {
        id,
        sessionID: 'ses_1',
        role: 'assistant',
        time: {
            created,
            ...(options.completed !== undefined ? { completed: options.completed } : {}),
        },
        ...(options.finish ? { finish: options.finish } : {}),
        ...(options.error ? { error: options.error } : {}),
        ...(options.files || options.start || options.end
            ? {
                snapshot: {
                    ...(options.start ? { start: options.start } : {}),
                    ...(options.end ? { end: options.end } : {}),
                    ...(options.files ? { files: options.files } : {}),
                },
            }
            : {}),
        ...(options.turnIdle ? { turnIdle: options.turnIdle } : {}),
    },
    parts: [
        {
            id: `${id}:text:0`,
            sessionID: 'ses_1',
            messageID: id,
            type: 'text',
            text: 'done',
        },
    ],
});

describe('OpenCode v2 turn diff projection', () => {
    test('normalizeSessionProjectionPage preserves assistant snapshot and stamps idle marker on preceding row', () => {
        const page = normalizeSessionProjectionPage(
            {
                data: [
                    { id: 'msg_idle_1', type: 'idle', outcome: 'interrupted', time: { created: 300 } },
                    {
                        id: 'msg_asst_1',
                        type: 'assistant',
                        finish: 'stop',
                        snapshot: { start: 'snap_a', end: 'snap_b', files: ['src/b.ts', 'src/a.ts'] },
                        content: [{ type: 'text', text: 'partial' }],
                        time: { created: 200, completed: 250 },
                    },
                    { id: 'msg_user_1', type: 'user', text: 'edit files', time: { created: 100 } },
                ],
            },
            'ses_1',
            'desc',
            20,
        );

        expect(page.records).toHaveLength(2);
        expect(page.records[0]?.info.id).toBe('msg_user_1');
        expect(page.records[1]?.info.id).toBe('msg_asst_1');
        expect(page.records[1]?.info.snapshot).toEqual({
            start: 'snap_a',
            end: 'snap_b',
            files: ['src/b.ts', 'src/a.ts'],
        });
        expect(page.records[1]?.info.turnIdle).toEqual({
            id: 'msg_idle_1',
            outcome: 'interrupted',
        });
    });

    test('live SSE step lifecycle preserves snapshot start/end/files across started -> ended', () => {
        const draft: TranscriptEventDraft = { message: {}, part: {} };

        applyTranscriptDirectoryEvent(draft, {
            type: 'session.step.started',
            properties: {
                sessionID: 'ses_1',
                assistantMessageID: 'msg_asst_1',
                snapshot: 'snap_start',
                eventCreated: 100,
            },
        } as never);

        applyTranscriptDirectoryEvent(draft, {
            type: 'session.step.ended',
            properties: {
                sessionID: 'ses_1',
                assistantMessageID: 'msg_asst_1',
                finish: 'stop',
                snapshot: 'snap_end',
                files: ['src/a.ts'],
                eventCreated: 200,
            },
        } as never);

        expect(draft.message.ses_1?.[0]?.snapshot).toEqual({
            start: 'snap_start',
            end: 'snap_end',
            files: ['src/a.ts'],
        });
    });

    test('steered prompts merge into one diff card anchored to the opening user message at the final idle', () => {
        const messages: ChatMessageEntry[] = [
            makeUser('msg_u1', 100, 'first'),
            makeAssistant('msg_a1', 150, {
                finish: 'stop',
                completed: 180,
                start: 's1',
                end: 'e1',
                files: ['src/z.ts', 'src/a.ts'],
                // No turnIdle — user steered before idle!
            }),
            makeUser('msg_u2', 200, 'steered'),
            makeAssistant('msg_a2', 250, {
                finish: 'stop',
                completed: 280,
                start: 's2',
                end: 'e2',
                files: ['src/m.ts', 'src/a.ts'],
                turnIdle: { id: 'msg_idle_1', outcome: 'succeeded' },
            }),
        ];

        const result = projectTurnRecords(messages, { showTurnChangedFiles: true });
        expect(result.turns).toHaveLength(2);
        // Turn 1 had no idle marker, so it emits no diff card.
        expect(result.turns[0]?.turnDiffFiles).toBeUndefined();
        expect(result.turns[0]?.turnDiffFromMessageId).toBeUndefined();
        // Turn 2 closes the cycle and owns the single merged card using msg_u1 as `from`.
        expect(result.turns[1]?.turnDiffFromMessageId).toBe('msg_u1');
        expect(result.turns[1]?.turnDiffFiles).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
        expect(result.turns[1]?.turnIdleOutcome).toBe('succeeded');
        expect(result.turns[1]?.diffStats?.hasDiffs).toBe(true);
        expect(result.turns[1]?.diffStats?.files).toBe(3);
    });

    test('interrupted turn with modified files emits its own card, and a later turn gets a separate card', () => {
        const messages: ChatMessageEntry[] = [
            makeUser('msg_u1', 100, 'first'),
            makeAssistant('msg_a1', 150, {
                finish: 'error',
                completed: 180,
                error: { type: 'interrupted', message: 'Interrupted' },
                start: 's1',
                end: 'e1',
                files: ['src/a.ts'],
                turnIdle: { id: 'msg_idle_1', outcome: 'interrupted' },
            }),
            makeUser('msg_u2', 200, 'continue'),
            makeAssistant('msg_a2', 250, {
                finish: 'stop',
                completed: 280,
                start: 's2',
                end: 'e2',
                files: ['src/b.ts'],
                turnIdle: { id: 'msg_idle_2', outcome: 'succeeded' },
            }),
        ];

        const result = projectTurnRecords(messages, { showTurnChangedFiles: true });
        expect(result.turns[0]?.turnDiffFromMessageId).toBe('msg_u1');
        expect(result.turns[0]?.turnDiffFiles).toEqual(['src/a.ts']);
        expect(result.turns[0]?.turnIdleOutcome).toBe('interrupted');

        expect(result.turns[1]?.turnDiffFromMessageId).toBe('msg_u2');
        expect(result.turns[1]?.turnDiffFiles).toEqual(['src/b.ts']);
        expect(result.turns[1]?.turnIdleOutcome).toBe('succeeded');
    });

    test('unfinished or running turn without idle marker emits no diff card', () => {
        const messages: ChatMessageEntry[] = [
            makeUser('msg_u1', 100, 'done turn'),
            makeAssistant('msg_a1', 150, {
                finish: 'stop',
                completed: 180,
                files: ['src/a.ts'],
                turnIdle: { id: 'msg_idle_1', outcome: 'succeeded' },
            }),
            makeUser('msg_u2', 200, 'running turn'),
            makeAssistant('msg_a2', 250, {
                finish: 'tool-calls',
                files: ['src/b.ts'],
                // Still running / shutdown: no turnIdle!
            }),
        ];

        const result = projectTurnRecords(messages, { showTurnChangedFiles: true });
        expect(result.turns[0]?.turnDiffFiles).toEqual(['src/a.ts']);
        expect(result.turns[1]?.turnDiffFiles).toBeUndefined();
        expect(result.turns[1]?.diffStats).toBeUndefined();
    });

    test('insert-only idle materialization fills missing snapshot end/files and turnIdle onto live assistant rows', () => {
        const liveAssistant = makeAssistant('msg_a1', 150, {
            finish: 'stop',
            completed: 180,
            start: 'snap_start',
        });
        const httpAssistant = makeAssistant('msg_a1', 150, {
            finish: 'stop',
            completed: 180,
            start: 'snap_start',
            end: 'snap_end',
            files: ['src/live.ts'],
            turnIdle: { id: 'msg_idle_1', outcome: 'succeeded' },
        });

        const materialized = materializeSessionSnapshots(
            {
                message: { ses_1: [liveAssistant.info] },
                part: { msg_a1: liveAssistant.parts },
            },
            'ses_1',
            [httpAssistant],
            {
                merge: resolveSessionMergeStrategy({ purpose: 'materialize' }),
            },
        );

        expect(materialized.messagesChanged).toBe(true);
        expect(materialized.messages[0]?.snapshot).toEqual({
            start: 'snap_start',
            end: 'snap_end',
            files: ['src/live.ts'],
        });
        expect(materialized.messages[0]?.turnIdle).toEqual({
            id: 'msg_idle_1',
            outcome: 'succeeded',
        });
    });

    test('reconcileFetched preserves fetched snapshot and turnIdle even when SSE touched the live row', () => {
        const liveAssistant = makeAssistant('msg_a1', 150, {
            finish: 'stop',
            completed: 180,
            start: 'snap_start',
        });
        const fetchedAssistant = makeAssistant('msg_a1', 150, {
            finish: 'stop',
            completed: 180,
            start: 'snap_start',
            end: 'snap_end',
            files: ['src/reconciled.ts'],
            turnIdle: { id: 'msg_idle_2', outcome: 'succeeded' },
        });

        const reconciled = reconcileFetched({
            fetched: [fetchedAssistant],
            previous: [liveAssistant],
            touched: new Set(['msg_a1']),
            completeTail: true,
        });

        expect(reconciled[0]?.info.snapshot).toEqual({
            start: 'snap_start',
            end: 'snap_end',
            files: ['src/reconciled.ts'],
        });
        expect(reconciled[0]?.info.turnIdle).toEqual({
            id: 'msg_idle_2',
            outcome: 'succeeded',
        });
    });

    test('does not attach Turn 1 edits onto a trailing read-only Q&A turn in the same execution cycle', () => {
        const messages: ChatMessageEntry[] = [
            makeUser('msg_u1', 100, 'edit proto and docs'),
            makeAssistant('msg_a1', 150, {
                finish: 'stop',
                completed: 180,
                start: 'snap_1',
                end: 'snap_2',
                files: [
                    'docs/group-chat-notify-protocol.md',
                    'docs/kf-bypass-contract.md',
                    'src/lib/rpc/protobuf/protobuf.d.ts',
                    'proto/session.proto',
                ],
                // No idle between Turn 1 and Turn 2 (user queued Turn 2 while busy).
            }),
            makeUser('msg_u2', 190, 'what is the relation between request_id and relayId?'),
            makeAssistant('msg_a2', 200, {
                finish: 'stop',
                completed: 220,
                // Zero file edits in Turn 2; single idle closes the busy period.
                turnIdle: { id: 'msg_idle_1', outcome: 'succeeded' },
            }),
        ];

        const result = projectTurnRecords(messages, { showTurnChangedFiles: true });
        expect(result.turns).toHaveLength(2);
        // Card attaches to Turn 1 (the turn that actually edited files), NOT Turn 2!
        expect(result.turns[0]?.turnDiffFromMessageId).toBe('msg_u1');
        expect(result.turns[0]?.turnDiffFiles).toEqual([
            'docs/group-chat-notify-protocol.md',
            'docs/kf-bypass-contract.md',
            'proto/session.proto',
            'src/lib/rpc/protobuf/protobuf.d.ts',
        ]);
        expect(result.turns[0]?.turnIdleOutcome).toBe('succeeded');
        expect(result.turns[1]?.turnDiffFromMessageId).toBeUndefined();
        expect(result.turns[1]?.turnDiffFiles).toBeUndefined();
        expect(result.turns[1]?.diffStats).toBeUndefined();
    });

    test('preserves page-boundary leading idle marker as precededByTurnIdle so older turn edits never leak forward', () => {
        // Newer page (desc) happened to cut right before idle_1 so idle_1 is oldest on the page.
        const newerPage = normalizeSessionProjectionPage(
            {
                data: [
                    { id: 'msg_idle_2', type: 'idle', outcome: 'succeeded', time: { created: 230 } },
                    {
                        id: 'msg_a2',
                        type: 'assistant',
                        time: { created: 200, completed: 220 },
                        finish: 'stop',
                        snapshot: { start: 's2', end: 'e2', files: ['src/turn2.ts'] },
                        content: [{ type: 'text', text: 'turn 2 edit' }],
                    },
                    { id: 'msg_u2', type: 'user', time: { created: 190 }, text: 'turn 2 prompt' },
                    { id: 'msg_idle_1', type: 'idle', outcome: 'succeeded', time: { created: 185 } },
                ],
                cursor: { next: 'cur_older' },
            },
            'ses_1',
            'desc',
            20,
        );

        expect(newerPage.records[0]?.info.id).toBe('msg_u2');
        expect(newerPage.records[0]?.info.precededByTurnIdle).toEqual({
            id: 'msg_idle_1',
            outcome: 'succeeded',
        });

        // Older page contains Turn 1 without idle_1 (since idle_1 was on newerPage).
        const olderMessages: ChatMessageEntry[] = [
            makeUser('msg_u1', 100, 'turn 1 prompt'),
            makeAssistant('msg_a1', 150, {
                finish: 'stop',
                completed: 180,
                start: 's1',
                end: 'e1',
                files: ['src/turn1.ts'],
            }),
        ];

        const stitched: ChatMessageEntry[] = [
            ...olderMessages,
            ...newerPage.records.map((record) => ({
                info: record.info,
                parts: [...(record.parts ?? [])],
            })),
        ];

        const result = projectTurnRecords(stitched, { showTurnChangedFiles: true });
        expect(result.turns).toHaveLength(2);
        expect(result.turns[0]?.turnDiffFromMessageId).toBe('msg_u1');
        expect(result.turns[0]?.turnDiffFiles).toEqual(['src/turn1.ts']);
        expect(result.turns[0]?.turnIdleOutcome).toBe('succeeded');
        expect(result.turns[1]?.turnDiffFromMessageId).toBe('msg_u2');
        expect(result.turns[1]?.turnDiffFiles).toEqual(['src/turn2.ts']);
        expect(result.turns[1]?.turnIdleOutcome).toBe('succeeded');
    });
});
