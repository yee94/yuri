import {
    getRelativeFilePath,
    isFilePathWithinDirectory,
    normalizeFilePath,
    toAbsoluteFilePath,
} from '@/lib/path-utils';
import { getPatchText, patchFilePath } from '../../message/parts/toolDiffUtils';
import type { ChatMessageEntry } from './types';

export interface TurnWorkspaceFileChange {
    /** Canonical display/selection path, e.g. `mmbizwxaaiagent/src/tablekv.cc`. */
    file: string;
    /** Attached workspace directory that owns this file. */
    repoDirectory: string;
    /** Path relative to `repoDirectory`. */
    repoRelativePath: string;
    /** Normalized absolute path on the owning machine. */
    absolutePath: string;
    additions: number;
    deletions: number;
    status: 'added' | 'deleted' | 'modified';
    patch?: string;
    before?: string;
    after?: string;
    /** Assistant message IDs whose tool parts contributed to this file change. */
    sourceMessageIds: string[];
    /** True when any contributing tool part was slimmed and lacks patch/body text. */
    hasSlimParts: boolean;
}

const EDIT_TOOL_NAMES = new Set([
    'edit',
    'multiedit',
    'write',
    'create',
    'file_write',
    'apply_patch',
    'patch',
]);

const WRITE_TOOL_NAMES = new Set(['write', 'create', 'file_write']);

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeEditToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return '';
    const last = trimmed.includes('.') ? (trimmed.split('.').filter(Boolean).pop() ?? trimmed) : trimmed;
    if (last === 'patch') return 'apply_patch';
    return last;
};

const parseNonNegativeInt = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.trunc(value));
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
            return Math.max(0, parsed);
        }
    }
    return undefined;
};

const countPatchLines = (patch: string): { additions: number; deletions: number } => {
    let additions = 0;
    let deletions = 0;
    for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) additions += 1;
        if (line.startsWith('-')) deletions += 1;
    }
    return { additions, deletions };
};

const synthesizeAddedFilePatch = (displayPath: string, content: string): { patch: string; additions: number } => {
    const normalized = content.replace(/\r\n/g, '\n');
    const rawLines = normalized.split('\n');
    const lines = rawLines.length > 1 && rawLines[rawLines.length - 1] === ''
        ? rawLines.slice(0, -1)
        : rawLines;
    if (lines.length === 0) {
        return {
            patch: `--- /dev/null\n+++ b/${displayPath}\n@@ -0,0 +1,0 @@`,
            additions: 0,
        };
    }
    const header = `--- /dev/null\n+++ b/${displayPath}\n@@ -0,0 +1,${lines.length} @@`;
    const body = lines.map((line) => `+${line}`).join('\n');
    return {
        patch: `${header}\n${body}`,
        additions: lines.length,
    };
};

const detectPatchStatus = (patch: string | undefined, explicitType?: unknown): 'added' | 'deleted' | 'modified' => {
    if (typeof explicitType === 'string') {
        const lower = explicitType.trim().toLowerCase();
        if (lower === 'add' || lower === 'added' || lower === 'create' || lower === 'created') return 'added';
        if (lower === 'delete' || lower === 'deleted' || lower === 'remove' || lower === 'removed') return 'deleted';
    }
    if (patch) {
        if (/^---\s+\/dev\/null(?:\s|$)/m.test(patch)) return 'added';
        if (/^\+\+\+\s+\/dev\/null(?:\s|$)/m.test(patch)) return 'deleted';
    }
    return 'modified';
};

const extractUnifiedHunks = (patch: string): string => {
    const normalized = patch.replace(/\r\n/g, '\n').trim();
    const lines = normalized.split('\n');
    const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
    if (firstHunk < 0) return '';
    return lines.slice(firstHunk).join('\n');
};

const combineUnifiedPatches = (
    displayPath: string,
    existingPatch: string | undefined,
    incomingPatch: string | undefined,
): string | undefined => {
    if (!incomingPatch) return existingPatch;
    if (!existingPatch) return incomingPatch;
    const existingHunks = extractUnifiedHunks(existingPatch);
    const incomingHunks = extractUnifiedHunks(incomingPatch);
    if (!existingHunks) return incomingPatch;
    if (!incomingHunks) return existingPatch;
    const isAdded = /^---\s+\/dev\/null(?:\s|$)/m.test(existingPatch);
    const fromHeader = isAdded ? '--- /dev/null' : `--- a/${displayPath}`;
    return `${fromHeader}\n+++ b/${displayPath}\n${existingHunks}\n${incomingHunks}`;
};

const splitSegments = (dir: string): string[] => normalizeFilePath(dir).split('/').filter(Boolean);

/**
 * Computes a short, collision-free display label for every normalized directory
 * in a multi-path workspace. Usually the basename; parent segments are added
 * only when two attached directories share the same basename.
 */
export const buildWorkspaceRepoLabels = (workspaceDirectories: readonly string[]): Map<string, string> => {
    const uniqueDirs: string[] = [];
    const seen = new Set<string>();
    for (const raw of workspaceDirectories) {
        const normalized = normalizeFilePath(raw);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        uniqueDirs.push(normalized);
    }

    const labels = new Map<string, string>();
    const segmentsByDir = new Map<string, string[]>();
    for (const dir of uniqueDirs) {
        segmentsByDir.set(dir, splitSegments(dir));
    }

    let depth = 1;
    let unresolved = [...uniqueDirs];
    while (unresolved.length > 0 && depth <= 8) {
        const buckets = new Map<string, string[]>();
        for (const dir of unresolved) {
            const segments = segmentsByDir.get(dir) ?? [];
            const candidate = segments.length > 0
                ? segments.slice(-Math.min(depth, segments.length)).join('/')
                : dir;
            const list = buckets.get(candidate) ?? [];
            list.push(dir);
            buckets.set(candidate, list);
        }

        const nextUnresolved: string[] = [];
        for (const [candidate, dirs] of buckets) {
            if (dirs.length === 1) {
                labels.set(dirs[0]!, candidate);
            } else {
                for (const dir of dirs) {
                    const segments = segmentsByDir.get(dir) ?? [];
                    if (depth >= segments.length) {
                        labels.set(dir, dir);
                    } else {
                        nextUnresolved.push(dir);
                    }
                }
            }
        }
        unresolved = nextUnresolved;
        depth += 1;
    }

    for (const dir of unresolved) {
        labels.set(dir, dir);
    }
    return labels;
};

export const prefixWorkspaceFilePath = (
    relativePath: string,
    directory: string,
    repoLabels: ReadonlyMap<string, string>,
): string => {
    const normalizedDir = normalizeFilePath(directory);
    const label = repoLabels.get(normalizedDir) ?? (splitSegments(normalizedDir).at(-1) || normalizedDir);
    if (!label) return relativePath;
    const cleanRel = relativePath.replace(/^\.\//, '');
    return `${label}/${cleanRel}`;
};

export interface WorkspaceResolvedFile {
    directory: string;
    relativePath: string;
    absolutePath: string;
    displayPath: string;
}

/**
 * Resolves a raw file path (absolute, relative to `sessionDirectory`, or already
 * prefixed with a workspace repo label) to its owning directory in `workspaceDirectories`.
 */
export const resolveWorkspaceFileTarget = (
    filePath: string,
    sessionDirectory: string,
    workspaceDirectories: readonly string[],
): WorkspaceResolvedFile | null => {
    const normalizedInput = normalizeFilePath(filePath);
    if (!normalizedInput) return null;

    const normalizedDirs: string[] = [];
    const seen = new Set<string>();
    for (const dir of workspaceDirectories) {
        const normalized = normalizeFilePath(dir);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        normalizedDirs.push(normalized);
    }
    if (normalizedDirs.length === 0) return null;

    const repoLabels = buildWorkspaceRepoLabels(normalizedDirs);
    const isMulti = normalizedDirs.length > 1;

    // 1) Check already-prefixed `<repoLabel>/<relativePath>` form first when multi-path.
    if (isMulti && !normalizedInput.startsWith('/')) {
        let bestPrefixMatch: { dir: string; label: string; rel: string } | null = null;
        for (const dir of normalizedDirs) {
            const label = repoLabels.get(dir);
            if (!label) continue;
            const prefix = `${label}/`;
            if (normalizedInput.startsWith(prefix)) {
                const rel = normalizedInput.slice(prefix.length);
                if (rel && (!bestPrefixMatch || label.length > bestPrefixMatch.label.length)) {
                    bestPrefixMatch = { dir, label, rel };
                }
            }
        }
        if (bestPrefixMatch) {
            const absolutePath = toAbsoluteFilePath(bestPrefixMatch.dir, bestPrefixMatch.rel);
            return {
                directory: bestPrefixMatch.dir,
                relativePath: bestPrefixMatch.rel,
                absolutePath,
                displayPath: `${bestPrefixMatch.label}/${bestPrefixMatch.rel}`,
            };
        }
    }

    // 2) Resolve absolute or sessionDirectory-relative path against all workspace roots (longest match wins).
    const absolutePath = toAbsoluteFilePath(sessionDirectory, normalizedInput);
    if (!absolutePath) return null;

    let matchedDir: string | null = null;
    for (const dir of normalizedDirs) {
        if (isFilePathWithinDirectory(absolutePath, dir)) {
            if (!matchedDir || dir.length > matchedDir.length) {
                matchedDir = dir;
            }
        }
    }
    if (!matchedDir) return null;

    const relativePath = getRelativeFilePath(absolutePath, matchedDir);
    if (!relativePath || relativePath === '.') return null;

    return {
        directory: matchedDir,
        relativePath,
        absolutePath,
        displayPath: isMulti ? prefixWorkspaceFilePath(relativePath, matchedDir, repoLabels) : relativePath,
    };
};

interface ExtractedPartFile {
    rawPath: string;
    additions?: number;
    deletions?: number;
    patch?: string;
    before?: string;
    after?: string;
    status: 'added' | 'deleted' | 'modified';
    isSlim: boolean;
}

const extractFileEditsFromToolPart = (part: unknown): ExtractedPartFile[] => {
    if (!isRecord(part) || part.type !== 'tool') return [];
    const toolName = normalizeEditToolName(part.tool);
    if (!EDIT_TOOL_NAMES.has(toolName)) return [];

    const state = isRecord(part.state) ? part.state : undefined;
    if (!state) return [];
    if (typeof state.status === 'string' && state.status !== 'completed') return [];

    const metadata = isRecord(state.metadata) ? state.metadata : undefined;
    const input = isRecord(state.input) ? state.input : undefined;
    const isSlim = part.slim === true;
    const extracted: ExtractedPartFile[] = [];

    const metaFiles = Array.isArray(metadata?.files) ? metadata.files : [];
    for (const file of metaFiles) {
        if (!isRecord(file)) continue;
        const rawPath = patchFilePath(file)
            || (typeof file.path === 'string' ? file.path.trim() : '');
        if (!rawPath) continue;
        const patch = getPatchText(file.patch) ?? getPatchText(file.diff);
        const before = typeof file.before === 'string' ? file.before : undefined;
        const after = typeof file.after === 'string' ? file.after : undefined;
        const counted = patch ? countPatchLines(patch) : undefined;
        extracted.push({
            rawPath,
            additions: parseNonNegativeInt(file.additions) ?? counted?.additions,
            deletions: parseNonNegativeInt(file.deletions) ?? counted?.deletions,
            patch,
            before,
            after,
            status: detectPatchStatus(patch, file.type ?? file.status),
            isSlim: isSlim || (!patch && before === undefined && after === undefined),
        });
    }

    if (extracted.length === 0 && isRecord(metadata?.filediff)) {
        const fd = metadata.filediff;
        const rawPath = patchFilePath(fd)
            || (typeof fd.path === 'string' ? fd.path.trim() : '');
        if (rawPath) {
            const patch = getPatchText(fd.patch)
                ?? getPatchText(fd.diff)
                ?? getPatchText(metadata?.patch)
                ?? getPatchText(metadata?.diff);
            const before = typeof fd.before === 'string' ? fd.before : undefined;
            const after = typeof fd.after === 'string' ? fd.after : undefined;
            const counted = patch ? countPatchLines(patch) : undefined;
            extracted.push({
                rawPath,
                additions: parseNonNegativeInt(fd.additions) ?? parseNonNegativeInt(metadata?.additions) ?? counted?.additions,
                deletions: parseNonNegativeInt(fd.deletions) ?? parseNonNegativeInt(metadata?.deletions) ?? counted?.deletions,
                patch,
                before,
                after,
                status: detectPatchStatus(patch, fd.status),
                isSlim: isSlim || (!patch && before === undefined && after === undefined),
            });
        }
    }

    if (extracted.length === 0 && Array.isArray(metadata?.results)) {
        for (const result of metadata.results) {
            if (!isRecord(result) || !isRecord(result.filediff)) continue;
            const fd = result.filediff;
            const rawPath = patchFilePath(fd)
                || (typeof fd.path === 'string' ? fd.path.trim() : '');
            if (!rawPath) continue;
            const patch = getPatchText(fd.patch) ?? getPatchText(fd.diff);
            const before = typeof fd.before === 'string' ? fd.before : undefined;
            const after = typeof fd.after === 'string' ? fd.after : undefined;
            const counted = patch ? countPatchLines(patch) : undefined;
            extracted.push({
                rawPath,
                additions: parseNonNegativeInt(fd.additions) ?? counted?.additions,
                deletions: parseNonNegativeInt(fd.deletions) ?? counted?.deletions,
                patch,
                before,
                after,
                status: detectPatchStatus(patch, fd.status),
                isSlim: isSlim || (!patch && before === undefined && after === undefined),
            });
        }
    }

    if (extracted.length === 0) {
        const inputPath = typeof input?.filePath === 'string' ? input.filePath.trim()
            : typeof input?.file_path === 'string' ? input.file_path.trim()
                : typeof input?.path === 'string' ? input.path.trim()
                    : '';
        if (inputPath) {
            const topPatch = getPatchText(metadata?.patch) ?? getPatchText(metadata?.diff);
            if (topPatch) {
                const counted = countPatchLines(topPatch);
                extracted.push({
                    rawPath: inputPath,
                    additions: parseNonNegativeInt(metadata?.additions) ?? counted.additions,
                    deletions: parseNonNegativeInt(metadata?.deletions) ?? counted.deletions,
                    patch: topPatch,
                    status: detectPatchStatus(topPatch),
                    isSlim: false,
                });
            } else if (WRITE_TOOL_NAMES.has(toolName) && typeof input?.content === 'string') {
                const synthesized = synthesizeAddedFilePatch(inputPath, input.content);
                extracted.push({
                    rawPath: inputPath,
                    additions: parseNonNegativeInt(metadata?.additions) ?? synthesized.additions,
                    deletions: parseNonNegativeInt(metadata?.deletions) ?? 0,
                    patch: synthesized.patch,
                    status: 'added',
                    isSlim: false,
                });
            } else if (
                !isSlim
                && typeof (input?.oldString ?? input?.old_string) === 'string'
                && typeof (input?.newString ?? input?.new_string) === 'string'
            ) {
                const oldText = (typeof input?.oldString === 'string' ? input.oldString : input?.old_string) as string;
                const newText = (typeof input?.newString === 'string' ? input.newString : input?.new_string) as string;
                extracted.push({
                    rawPath: inputPath,
                    additions: parseNonNegativeInt(metadata?.additions),
                    deletions: parseNonNegativeInt(metadata?.deletions),
                    before: oldText,
                    after: newText,
                    status: 'modified',
                    isSlim: false,
                });
            } else {
                extracted.push({
                    rawPath: inputPath,
                    additions: parseNonNegativeInt(metadata?.additions),
                    deletions: parseNonNegativeInt(metadata?.deletions),
                    status: WRITE_TOOL_NAMES.has(toolName) ? 'added' : 'modified',
                    isSlim: true,
                });
            }
        }
    }

    return extracted;
};

/**
 * Merge two `TurnWorkspaceFileChange` maps/lists in chronological order.
 */
export const mergeTurnWorkspaceFileChanges = (
    target: Map<string, TurnWorkspaceFileChange>,
    incoming: readonly TurnWorkspaceFileChange[],
): void => {
    for (const item of incoming) {
        const existing = target.get(item.absolutePath);
        if (!existing) {
            target.set(item.absolutePath, {
                ...item,
                sourceMessageIds: [...item.sourceMessageIds],
            });
            continue;
        }

        const mergedMessageIds = new Set(existing.sourceMessageIds);
        for (const id of item.sourceMessageIds) mergedMessageIds.add(id);

        const hasBeforeAfter = existing.before !== undefined && item.after !== undefined;
        existing.additions += item.additions;
        existing.deletions += item.deletions;
        existing.sourceMessageIds = [...mergedMessageIds];
        existing.hasSlimParts = existing.hasSlimParts || item.hasSlimParts;
        if (hasBeforeAfter) {
            existing.after = item.after;
            existing.patch = undefined;
        } else {
            existing.patch = combineUnifiedPatches(existing.file, existing.patch, item.patch);
            if (item.before !== undefined && existing.before === undefined) existing.before = item.before;
            if (item.after !== undefined) existing.after = item.after;
        }
        if (item.status === 'deleted') {
            existing.status = 'deleted';
        }
    }
};

/**
 * Collects completed file edits made inside associated (non-primary) directories
 * of a multi-path workspace across the provided assistant messages.
 *
 * OpenCode's git snapshot (`assistant.info.snapshot` and `GET /api/session/:id/diff`)
 * only tracks the session's single primary directory, so edits to other attached
 * repositories in a multi-project workspace are missing from snapshot diffs.
 */
export const collectTurnWorkspaceToolChanges = (
    assistantMessages: readonly ChatMessageEntry[],
    sessionDirectory: string | null | undefined,
    workspaceDirectories: readonly string[] | null | undefined,
): TurnWorkspaceFileChange[] => {
    if (!sessionDirectory || !workspaceDirectories || workspaceDirectories.length <= 1) {
        return [];
    }

    const normalizedSessionDir = normalizeFilePath(sessionDirectory);
    if (!normalizedSessionDir) return [];

    const secondaryDirs: string[] = [];
    const seen = new Set<string>();
    for (const dir of workspaceDirectories) {
        const normalized = normalizeFilePath(dir);
        if (!normalized || normalized === normalizedSessionDir || seen.has(normalized)) continue;
        seen.add(normalized);
        secondaryDirs.push(normalized);
    }
    if (secondaryDirs.length === 0) return [];

    const repoLabels = buildWorkspaceRepoLabels([normalizedSessionDir, ...secondaryDirs]);
    const byAbsolutePath = new Map<string, TurnWorkspaceFileChange>();

    for (const message of assistantMessages) {
        const messageId = message.info?.id;
        for (const part of message.parts ?? []) {
            const edits = extractFileEditsFromToolPart(part);
            if (edits.length === 0) continue;

            for (const edit of edits) {
                const absolutePath = toAbsoluteFilePath(normalizedSessionDir, edit.rawPath);
                if (!absolutePath) continue;

                // Match against secondary workspace directories only (longest match wins).
                let matchedSecondary: string | null = null;
                for (const dir of secondaryDirs) {
                    if (isFilePathWithinDirectory(absolutePath, dir)) {
                        if (!matchedSecondary || dir.length > matchedSecondary.length) {
                            matchedSecondary = dir;
                        }
                    }
                }
                if (!matchedSecondary) continue;

                const repoRelativePath = getRelativeFilePath(absolutePath, matchedSecondary);
                if (!repoRelativePath || repoRelativePath === '.') continue;

                const displayPath = prefixWorkspaceFilePath(repoRelativePath, matchedSecondary, repoLabels);
                const normalizedPatch = edit.patch;
                const entry: TurnWorkspaceFileChange = {
                    file: displayPath,
                    repoDirectory: matchedSecondary,
                    repoRelativePath,
                    absolutePath,
                    additions: edit.additions ?? 0,
                    deletions: edit.deletions ?? 0,
                    status: edit.status,
                    ...(normalizedPatch ? { patch: normalizedPatch } : {}),
                    ...(edit.before !== undefined ? { before: edit.before } : {}),
                    ...(edit.after !== undefined ? { after: edit.after } : {}),
                    sourceMessageIds: typeof messageId === 'string' && messageId ? [messageId] : [],
                    hasSlimParts: edit.isSlim,
                };
                mergeTurnWorkspaceFileChanges(byAbsolutePath, [entry]);
            }
        }
    }

    return [...byAbsolutePath.values()].sort((a, b) => a.file.localeCompare(b.file));
};

export const areTurnWorkspaceChangesEqual = (
    left?: readonly TurnWorkspaceFileChange[],
    right?: readonly TurnWorkspaceFileChange[],
): boolean => {
    if (left === right) return true;
    if (!left || !right) return !left && !right;
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
        const a = left[i]!;
        const b = right[i]!;
        if (
            a.file !== b.file
            || a.repoDirectory !== b.repoDirectory
            || a.repoRelativePath !== b.repoRelativePath
            || a.absolutePath !== b.absolutePath
            || a.additions !== b.additions
            || a.deletions !== b.deletions
            || a.status !== b.status
            || a.patch !== b.patch
            || a.before !== b.before
            || a.after !== b.after
            || a.hasSlimParts !== b.hasSlimParts
            || a.sourceMessageIds.length !== b.sourceMessageIds.length
            || a.sourceMessageIds.some((id, idx) => id !== b.sourceMessageIds[idx])
        ) {
            return false;
        }
    }
    return true;
};
