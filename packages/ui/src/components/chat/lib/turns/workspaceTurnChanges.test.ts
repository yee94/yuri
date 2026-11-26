import { describe, expect, test } from 'vitest';
import type { Message, Part } from '@/lib/opencode/v2-types';
import {
    areTurnWorkspaceChangesEqual,
    buildWorkspaceRepoLabels,
    collectTurnWorkspaceToolChanges,
    prefixWorkspaceFilePath,
    resolveWorkspaceFileTarget,
} from './workspaceTurnChanges';
import type { ChatMessageEntry } from './types';

const makeAssistantMessage = (id: string, parts: unknown[]): ChatMessageEntry => ({
    info: {
        id,
        role: 'assistant',
        sessionID: 'ses_1',
        time: { created: 100, completed: 200 },
    } as Message,
    parts: parts as Part[],
});

describe('buildWorkspaceRepoLabels & prefixWorkspaceFilePath', () => {
    test('uses basenames when distinct and disambiguates duplicate basenames with parent segments', () => {
        const distinct = buildWorkspaceRepoLabels(['/workspace/app-node', '/workspace/mmbizwxaaiagent']);
        expect(distinct.get('/workspace/app-node')).toBe('app-node');
        expect(distinct.get('/workspace/mmbizwxaaiagent')).toBe('mmbizwxaaiagent');
        expect(prefixWorkspaceFilePath('src/tablekv.cc', '/workspace/mmbizwxaaiagent', distinct)).toBe(
            'mmbizwxaaiagent/src/tablekv.cc',
        );

        const duplicates = buildWorkspaceRepoLabels(['/team-a/service', '/team-b/service']);
        expect(duplicates.get('/team-a/service')).toBe('team-a/service');
        expect(duplicates.get('/team-b/service')).toBe('team-b/service');
    });
});

describe('resolveWorkspaceFileTarget', () => {
    const dirs = ['/workspace/app-node', '/workspace/mmbizwxaaiagent'];

    test('resolves prefixed paths, secondary absolute paths, and primary relative paths', () => {
        expect(resolveWorkspaceFileTarget('mmbizwxaaiagent/src/tablekv.cc', '/workspace/app-node', dirs)).toEqual({
            directory: '/workspace/mmbizwxaaiagent',
            relativePath: 'src/tablekv.cc',
            absolutePath: '/workspace/mmbizwxaaiagent/src/tablekv.cc',
            displayPath: 'mmbizwxaaiagent/src/tablekv.cc',
        });

        expect(resolveWorkspaceFileTarget('/workspace/mmbizwxaaiagent/src/tablekv.cc', '/workspace/app-node', dirs)).toEqual({
            directory: '/workspace/mmbizwxaaiagent',
            relativePath: 'src/tablekv.cc',
            absolutePath: '/workspace/mmbizwxaaiagent/src/tablekv.cc',
            displayPath: 'mmbizwxaaiagent/src/tablekv.cc',
        });

        expect(resolveWorkspaceFileTarget('src/index.ts', '/workspace/app-node', dirs)).toEqual({
            directory: '/workspace/app-node',
            relativePath: 'src/index.ts',
            absolutePath: '/workspace/app-node/src/index.ts',
            displayPath: 'app-node/src/index.ts',
        });

        expect(resolveWorkspaceFileTarget('/outside/other/file.ts', '/workspace/app-node', dirs)).toBeNull();
    });
});

describe('collectTurnWorkspaceToolChanges', () => {
    const dirs = ['/workspace/app-node', '/workspace/mmbizwxaaiagent'];

    test('extracts completed secondary-repo edits across edit/write/apply_patch and ignores primary/outside/running parts', () => {
        const msg1 = makeAssistantMessage('a1', [
            {
                id: 'p1',
                type: 'tool',
                tool: 'edit',
                state: {
                    status: 'completed',
                    input: { filePath: '/workspace/app-node/src/primary.ts' },
                    metadata: {
                        filediff: {
                            file: '/workspace/app-node/src/primary.ts',
                            additions: 2,
                            deletions: 1,
                            diff: '@@ -1 +1,2 @@\n-a\n+b\n+c',
                        },
                    },
                },
            },
            {
                id: 'p2',
                type: 'tool',
                tool: 'apply_patch',
                state: {
                    status: 'completed',
                    metadata: {
                        files: [
                            {
                                file: '/workspace/mmbizwxaaiagent/src/tablekv.cc',
                                type: 'update',
                                additions: 4,
                                deletions: 2,
                                diff: '--- a/src/tablekv.cc\n+++ b/src/tablekv.cc\n@@ -1,2 +1,4 @@\n-old1\n-old2\n+new1\n+new2\n+new3\n+new4',
                            },
                            {
                                file: '/outside/unrelated.cc',
                                type: 'update',
                                additions: 1,
                                deletions: 0,
                                diff: '@@ -0,0 +1 @@\n+x',
                            },
                        ],
                    },
                },
            },
            {
                id: 'p3',
                type: 'tool',
                tool: 'write',
                state: {
                    status: 'completed',
                    input: {
                        filePath: '/workspace/mmbizwxaaiagent/src/new_helper.h',
                        content: 'line1\nline2\n',
                    },
                },
            },
            {
                id: 'p4',
                type: 'tool',
                tool: 'edit',
                state: {
                    status: 'running',
                    input: { filePath: '/workspace/mmbizwxaaiagent/src/in_flight.cc' },
                },
            },
        ]);

        const changes = collectTurnWorkspaceToolChanges([msg1], '/workspace/app-node', dirs);
        expect(changes.map((c) => c.file)).toEqual([
            'mmbizwxaaiagent/src/new_helper.h',
            'mmbizwxaaiagent/src/tablekv.cc',
        ]);
        expect(changes[0]).toMatchObject({
            repoDirectory: '/workspace/mmbizwxaaiagent',
            repoRelativePath: 'src/new_helper.h',
            status: 'added',
            additions: 2,
            deletions: 0,
            hasSlimParts: false,
            sourceMessageIds: ['a1'],
        });
        expect(changes[1]).toMatchObject({
            repoDirectory: '/workspace/mmbizwxaaiagent',
            repoRelativePath: 'src/tablekv.cc',
            status: 'modified',
            additions: 4,
            deletions: 2,
            hasSlimParts: false,
            sourceMessageIds: ['a1'],
        });
    });

    test('merges multiple edits to the same secondary file and tracks slim parts', () => {
        const msg1 = makeAssistantMessage('a1', [
            {
                id: 'p1',
                type: 'tool',
                tool: 'edit',
                slim: true,
                state: {
                    status: 'completed',
                    metadata: {
                        files: [
                            {
                                file: '/workspace/mmbizwxaaiagent/src/tablekv.cc',
                                additions: 3,
                                deletions: 1,
                            },
                        ],
                    },
                },
            },
        ]);
        const msg2 = makeAssistantMessage('a2', [
            {
                id: 'p2',
                type: 'tool',
                tool: 'edit',
                state: {
                    status: 'completed',
                    input: {
                        filePath: '/workspace/mmbizwxaaiagent/src/tablekv.cc',
                        oldString: 'foo',
                        newString: 'bar',
                    },
                    metadata: {
                        additions: 1,
                        deletions: 1,
                    },
                },
            },
        ]);

        const changes = collectTurnWorkspaceToolChanges([msg1, msg2], '/workspace/app-node', dirs);
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({
            file: 'mmbizwxaaiagent/src/tablekv.cc',
            additions: 4,
            deletions: 2,
            hasSlimParts: true,
            sourceMessageIds: ['a1', 'a2'],
            before: 'foo',
            after: 'bar',
        });
        expect(areTurnWorkspaceChangesEqual(changes, [...changes])).toBe(true);
    });
});
