import { isCompactionCommandMessage } from '../messageDisplayNormalization';
import { isSessionCompactionCard } from '@/sync/session-projection-api';
import { countContinuationToolParts, hasConfirmedFinalBody } from './assistantMessageLifecycle';
import { projectTurnActivity } from './projectTurnActivity';
import { projectTurnIndexes } from './projectTurnIndexes';
import { projectTurnChangedFiles, projectTurnDiffStats, projectTurnSummary } from './projectTurnSummary';
import type {
    ChatMessageEntry,
    TurnActivityPresentationKind,
    TurnCompletionDisposition,
    TurnMessageRecord,
    TurnProjectionResult,
    TurnRecord,
    TurnStreamState,
} from './types';

const resolveMessageRole = (message: ChatMessageEntry): string => {
    const role = (message.info as { clientRole?: string | null; role?: string | null }).clientRole ?? message.info.role;
    return typeof role === 'string' ? role : '';
};

/**
 * OpenCode 2 native synthetic rows (background / `<subagent …>` / `<shell …>`
 * notices) continue the current turn. Their ids are minted when the work is
 * backgrounded and `time.created` is stamped on completion, so as turn anchors
 * they split one reply and move later steps between blocks.
 */
const isNativeSyntheticNotice = (message: ChatMessageEntry): boolean =>
    (message.info as { nativeType?: unknown }).nativeType === 'synthetic';

const getMessageParentId = (message: ChatMessageEntry): string | undefined => {
    const parentId = (message.info as { parentID?: unknown }).parentID;
    if (typeof parentId !== 'string' || parentId.trim().length === 0) {
        return undefined;
    }
    return parentId;
};

const getMessageCreatedAt = (message: ChatMessageEntry): number | undefined => {
    const created = (message.info as { time?: { created?: unknown } }).time?.created;
    return typeof created === 'number' ? created : undefined;
};

const getMessageCompletedAt = (message: ChatMessageEntry): number | undefined => {
    const completed = (message.info as { time?: { completed?: unknown } }).time?.completed;
    return typeof completed === 'number' ? completed : undefined;
};

/**
 * Provider-body end (`time.streamed`). OpenCode 2 compaction writes this clock
 * and never `time.completed`; turn duration and TPS both have to accept it.
 */
const getMessageStreamedAt = (message: ChatMessageEntry): number | undefined => {
    const streamed = (message.info as { time?: { streamed?: unknown } }).time?.streamed;
    return typeof streamed === 'number' && Number.isFinite(streamed) ? streamed : undefined;
};

const getPartEndTime = (part: unknown): number | undefined => {
    const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end;
    if (typeof stateEnd === 'number') {
        return stateEnd;
    }
    const timeEnd = (part as { time?: { end?: unknown } }).time?.end;
    return typeof timeEnd === 'number' ? timeEnd : undefined;
};

const getUserSummaryBody = (message: ChatMessageEntry): string | undefined => {
    const summaryBody = (message.info as { summary?: { body?: unknown } | null | undefined })?.summary?.body;
    if (typeof summaryBody !== 'string') {
        return undefined;
    }

    const trimmed = summaryBody.trim();
    return trimmed.length > 0 ? summaryBody : undefined;
};

const createTurnMessageRecord = (message: ChatMessageEntry, order: number): TurnMessageRecord => {
    const role = resolveMessageRole(message);
    return {
        messageId: message.info.id,
        role,
        parentMessageId: getMessageParentId(message),
        message,
        order,
    };
};

const buildTurnStreamState = (userMessage: ChatMessageEntry | undefined, assistantMessages: ChatMessageEntry[]): TurnStreamState => {
    const startedAt = userMessage ? getMessageCreatedAt(userMessage) : undefined;
    let completedAt: number | undefined;
    let maxStreamedAt: number | undefined;
    let maxPartEndedAt: number | undefined;
    let isStreaming = false;

    assistantMessages.forEach((message) => {
        const completed = getMessageCompletedAt(message);
        if (typeof completed === 'number') {
            completedAt = Math.max(completedAt ?? 0, completed);
        } else {
            isStreaming = true;
        }
        // Compaction (and any other step that ends at the provider body) stamps
        // `time.streamed` and leaves `time.completed` empty. TPS already uses
        // that clock; duration must too, or a compacted turn shows tok/s with
        // no elapsed time.
        const streamed = getMessageStreamedAt(message);
        if (typeof streamed === 'number') {
            maxStreamedAt = Math.max(maxStreamedAt ?? 0, streamed);
        }
        message.parts.forEach((part) => {
            const endedAt = getPartEndTime(part);
            if (typeof endedAt === 'number') {
                maxPartEndedAt = Math.max(maxPartEndedAt ?? 0, endedAt);
            }
        });
    });

    // Prefer message completion; then the provider-stream boundary; then the
    // latest part end so abnormal-exit turns freeze instead of ticking forever.
    const durationEnd = completedAt ?? maxStreamedAt ?? maxPartEndedAt;
    const durationMs = typeof startedAt === 'number' && typeof durationEnd === 'number' && durationEnd >= startedAt
        ? durationEnd - startedAt
        : undefined;

    return {
        isStreaming,
        isRetrying: assistantMessages.length > 1,
        startedAt,
        completedAt,
        durationMs,
    };
};

/**
 * Disposition from the last assistant, with multi-step safety and the OpenCode
 * runLoop continuation semantics.
 *
 * - error → abnormal (authoritative even with a dangling tool)
 * - `finish === 'tool-calls'` → active
 * - any continuation tool part on the last assistant → active. Continuation
 *   means any ordinary (non-provider-executed) tool that is not an interrupted
 *   orphan — pending, running, *or completed*; the model may still owe a
 *   follow-up step for it. Provider-executed tools never block terminal stop.
 * - `finish === 'stop'` with zero continuation tools → normal
 * - other non-empty finish → abnormal
 * - Any assistant without `time.completed` → still active (next step not done)
 * - `time.completed` alone is **not** enough to settle: multi-step agents often
 *   stamp completed when a shell step ends, before the next assistant arrives.
 *   Treating that as abnormal collapses Activity and blanks nested tools for a
 *   frame (user-visible fold flash). Require a terminal finish/error, or
 *   settleHistoricalActiveTurns when a later user message proves the turn is over.
 */
const resolveTurnCompletionDisposition = (
    assistantMessages: ChatMessageEntry[],
): TurnCompletionDisposition => {
    if (assistantMessages.length === 0) {
        return 'active';
    }

    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    if (!lastAssistant) {
        return 'active';
    }

    const finish = (lastAssistant.info as { finish?: unknown }).finish;
    const error = (lastAssistant.info as { error?: unknown }).error;
    // Error is authoritative even alongside stop metadata: an aborted turn
    // settles even with a dangling tool.
    if (error) {
        return 'abnormal';
    }

    // Continuation semantics (OpenCode runLoop exit rule): `tool-calls`, or a
    // last assistant carrying any continuation tool part — provider-executed
    // tools and interrupted orphans excluded — means the loop is still owed a
    // step. A *completed* ordinary tool still counts.
    if (finish === 'tool-calls') {
        return 'active';
    }

    if (countContinuationToolParts(lastAssistant.parts) > 0) {
        return 'active';
    }

    if (finish === 'stop') {
        return 'normal';
    }

    if (typeof finish === 'string' && finish.length > 0) {
        // Non-stop terminal finish (length, canceled, ...).
        return 'abnormal';
    }

    // Any sibling still open → multi-step turn is live.
    for (const message of assistantMessages) {
        if (typeof getMessageCompletedAt(message) !== 'number') {
            return 'active';
        }
    }

    // `time.completed` alone is not a terminal settle. Multi-step agents stamp
    // it when a shell step ends, before the next assistant is appended; treating
    // that as abnormal collapses Activity and blanks nested tools. Real
    // abandons settle via error/finish, or settleHistoricalActiveTurns when a
    // later user message proves the turn is over.
    return 'active';
};

/**
 * Pure derivation from the current last assistant: confirmed terminal stop plus
 * a model-produced final text, vetoed by an error. Never latched — recomputed
 * per hydration, so a turn that grows a continuation step flips back to `false`.
 */
const resolveHasConfirmedFinalBody = (
    assistantMessages: ChatMessageEntry[],
): boolean => {
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    if (!lastAssistant) {
        return false;
    }
    const info = lastAssistant.info as { finish?: unknown; error?: unknown };
    return hasConfirmedFinalBody(info.finish, lastAssistant.parts, info.error);
};

/**
 * Compaction activity semantics from the user message only.
 * Matches display normalization: raw type=compaction, or normalized text exactly `/compact`.
 */
const resolveTurnActivityPresentationKind = (
    userMessage: ChatMessageEntry,
): TurnActivityPresentationKind => {
    return isCompactionCommandMessage(userMessage) ? 'compaction' : 'default';
};

interface ProjectTurnRecordsOptions {
    previousProjection?: TurnProjectionResult | null;
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
}

const DEFAULT_OPTIONS: ProjectTurnRecordsOptions = {
    previousProjection: null,
    showTextJustificationActivity: false,
    showTurnChangedFiles: false,
};

const areSameMessageRefs = (left: TurnMessageRecord[], right: TurnMessageRecord[]): boolean => {
    if (left === right) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        if (left[index].message !== right[index].message) {
            return false;
        }
    }

    return true;
};

const canReusePreviousTurn = (previous: TurnRecord, next: TurnRecord): boolean => {
    return previous.userMessage === next.userMessage
        && previous.headerMessageId === next.headerMessageId
        && areSameMessageRefs(previous.messages, next.messages);
};

const hydrateTurnRecord = (
    turn: TurnRecord,
    effectiveOptions: ProjectTurnRecordsOptions,
): TurnRecord => {
    turn.summary = projectTurnSummary(turn.assistantMessages);
    turn.summaryText = turn.summary.text ?? (turn.userMessage ? getUserSummaryBody(turn.userMessage) : undefined);
    turn.diffStats = turn.userMessage ? projectTurnDiffStats(turn.userMessage) : undefined;
    turn.changedFiles = effectiveOptions.showTurnChangedFiles && turn.userMessage
        ? projectTurnChangedFiles(turn.userMessage)
        : undefined;

    turn.completionDisposition = resolveTurnCompletionDisposition(turn.assistantMessages);
    turn.hasConfirmedFinalBody = resolveHasConfirmedFinalBody(turn.assistantMessages);
    // An automatic checkpoint after the last step is a continuation boundary,
    // not the terminal finish of the user's request. Live status still gates
    // the working presentation; a later assistant owns its own terminal result.
    for (let index = turn.messages.length - 1; index >= 0; index -= 1) {
        const record = turn.messages[index];
        if (record.role === 'assistant') break;
        if (record.role !== 'compaction') continue;
        const checkpoint = record.message.parts.find(isSessionCompactionCard);
        if (checkpoint?.reason === 'auto' && checkpoint.status !== 'failed') {
            turn.completionDisposition = 'active';
            turn.hasConfirmedFinalBody = false;
        }
        break;
    }
    turn.activityPresentationKind = turn.userMessage ? resolveTurnActivityPresentationKind(turn.userMessage) : 'default';

    const activity = projectTurnActivity({
        turnId: turn.turnId,
        assistantMessages: turn.assistantMessages,
        messages: turn.messages,
        showTextJustificationActivity: effectiveOptions.showTextJustificationActivity,
    });
    const previous = effectiveOptions.previousProjection?.indexes.turnById.get(turn.turnId);
    if (previous) {
        const previousSegments = new Map(previous.activitySegments.map((segment) => [segment.anchorMessageId, segment]));
        for (const segment of activity.activitySegments) {
            for (const part of segment.parts) {
                const retained = previousSegments.get(part.messageId);
                if (!retained) continue;
                segment.id = retained.id;
                segment.anchorMessageId = retained.anchorMessageId;
                break;
            }
        }
    }
    turn.activityParts = activity.activityParts;
    turn.activitySegments = activity.activitySegments;
    turn.hasTools = activity.hasTools;
    turn.hasReasoning = activity.hasReasoning;

    turn.stream = buildTurnStreamState(turn.userMessage, turn.assistantMessages);
    turn.startedAt = turn.stream.startedAt;
    turn.completedAt = turn.stream.completedAt;
    turn.durationMs = turn.stream.durationMs;
    return turn;
};

const hydrateStableTurnRecords = (
    turns: TurnRecord[],
    effectiveOptions: ProjectTurnRecordsOptions,
): TurnRecord[] => {
    const previousProjection = effectiveOptions.previousProjection;
    if (!previousProjection || previousProjection.turns.length === 0 || turns.length === 0) {
        return turns.map((turn) => hydrateTurnRecord(turn, effectiveOptions));
    }

    let canReuseTurnArray = previousProjection.turns.length === turns.length;
    let reusedAnyTurn = false;

    const nextTurns = turns.map((turn, index) => {
        const previousTurn = previousProjection.indexes.turnById.get(turn.turnId);
        if (previousTurn && canReusePreviousTurn(previousTurn, turn)) {
            reusedAnyTurn = true;
            if (previousProjection.turns[index] !== previousTurn) {
                canReuseTurnArray = false;
            }
            return previousTurn;
        }

        canReuseTurnArray = false;
        return hydrateTurnRecord(turn, effectiveOptions);
    });

    if (canReuseTurnArray && reusedAnyTurn) {
        return previousProjection.turns;
    }

    return nextTurns;
};

/**
 * A later user message proves the previous turn is no longer live. Incomplete
 * message metadata (abnormal exit without time.completed) must not keep older
 * turns as `active` with a live duration ticker.
 *
 * "Later user message" means one the server has begun answering. A queued or
 * optimistic user row merged into the viewport while the previous turn is still
 * streaming is not proof of anything: settling on it collapsed the running
 * turn's Activity the moment the user typed ahead. Wait for an assistant
 * response on the following turn. A turn abandoned mid-stream therefore keeps
 * ticking until the next turn is answered, which is the narrower failure.
 */
const areStringArraysEqual = (left?: string[], right?: string[]): boolean => {
    if (left === right) return true;
    if (!left || !right) return !left && !right;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
};

const readTurnIdleMarker = (turn: TurnRecord): { id?: string; outcome: 'succeeded' | 'failed' | 'interrupted' } | undefined => {
    for (let index = turn.messages.length - 1; index >= 0; index -= 1) {
        const marker = turn.messages[index]?.message.info.turnIdle;
        if (marker && (marker.outcome === 'succeeded' || marker.outcome === 'failed' || marker.outcome === 'interrupted')) {
            return marker;
        }
    }
    return undefined;
};

const readTurnLeadingIdleMarker = (turn: TurnRecord): { id?: string; outcome: 'succeeded' | 'failed' | 'interrupted' } | undefined => {
    const marker = turn.messages[0]?.message.info.precededByTurnIdle;
    if (marker && (marker.outcome === 'succeeded' || marker.outcome === 'failed' || marker.outcome === 'interrupted')) {
        return marker;
    }
    return undefined;
};

const collectTurnSnapshotFiles = (turn: TurnRecord): { files: string[]; tokens: string[] } => {
    const files: string[] = [];
    const tokens: string[] = [];
    for (const assistant of turn.assistantMessages) {
        const snapshot = assistant.info.snapshot;
        if (!snapshot) continue;
        if (snapshot.start) tokens.push(`s:${snapshot.start}`);
        if (snapshot.end) tokens.push(`e:${snapshot.end}`);
        if (Array.isArray(snapshot.files)) {
            for (const file of snapshot.files) {
                if (typeof file === 'string' && file.length > 0) {
                    files.push(file);
                }
            }
        }
    }
    return { files, tokens };
};

/**
 * OpenCode v2 turn-diff attribution across execution cycles.
 *
 * Mirrors OpenCode's Timeline projection with two attribution safeguards:
 * - Everything between two `idle` markers belongs to one execution cycle,
 *   including prompts steered/queued while busy (`from` stays the opening user
 *   message ID).
 * - Within an execution cycle, the diff card attaches to the **last turn that
 *   actually edited files** (`lastFileEditTurnIndex`) rather than a trailing
 *   read-only Q&A turn that touched zero files.
 * - Page-boundary `precededByTurnIdle` markers close the preceding turn before
 *   starting the next turn so edits never leak across a paginated boundary.
 * - Running or shutdown-interrupted turns have no `idle` marker and emit no card.
 * - User-interrupted / permission-rejected turns carry `idle(interrupted)` and
 *   emit a card whenever steps already wrote files.
 * - Sessions predating `idle` markers fall back to per-turn settled attribution.
 */
const applyV2TurnDiffProjection = (
    turns: TurnRecord[],
    showTurnChangedFiles: boolean,
): TurnRecord[] => {
    if (turns.length === 0) return turns;

    const leadingIdleMarkers = turns.map(readTurnLeadingIdleMarker);
    const idleMarkers = turns.map(readTurnIdleMarker);
    const hasIdleMarkers = idleMarkers.some(Boolean) || leadingIdleMarkers.some(Boolean);

    type PlannedTurnDiff = {
        turnIdleOutcome?: 'succeeded' | 'failed' | 'interrupted';
        turnDiffFromMessageId?: string;
        turnDiffFiles?: string[];
        turnDiffSignature?: string;
    };

    const planned: PlannedTurnDiff[] = turns.map((_, index) => ({
        turnIdleOutcome: idleMarkers[index]?.outcome,
    }));

    let execution: {
        opener: string;
        files: Set<string>;
        tokens: string[];
        lastFileEditTurnIndex: number;
    } | undefined;

    const closeExecution = (
        idle: { id?: string; outcome: 'succeeded' | 'failed' | 'interrupted' } | undefined,
        fallbackTurnIndex: number,
    ) => {
        if (showTurnChangedFiles && execution && execution.files.size > 0) {
            const targetIndex = execution.lastFileEditTurnIndex >= 0
                ? execution.lastFileEditTurnIndex
                : fallbackTurnIndex;
            const target = planned[targetIndex];
            if (target) {
                const files = [...execution.files].sort();
                target.turnDiffFromMessageId = execution.opener;
                target.turnDiffFiles = files;
                target.turnDiffSignature = [
                    idle ? (idle.id ?? idle.outcome) : undefined,
                    ...execution.tokens,
                    ...files,
                ].filter(Boolean).join('|');
                if (idle && !target.turnIdleOutcome) {
                    target.turnIdleOutcome = idle.outcome;
                }
            }
        }
        execution = undefined;
    };

    for (let index = 0; index < turns.length; index += 1) {
        const leadingIdle = leadingIdleMarkers[index];
        if (leadingIdle && execution) {
            if (index > 0 && !planned[index - 1]?.turnIdleOutcome) {
                planned[index - 1]!.turnIdleOutcome = leadingIdle.outcome;
            }
            closeExecution(leadingIdle, index - 1);
        }

        const turn = turns[index]!;
        const idle = idleMarkers[index];
        const snapshot = collectTurnSnapshotFiles(turn);

        if (turn.userMessageId) {
            if (!execution || !hasIdleMarkers) {
                execution = {
                    opener: turn.userMessageId,
                    files: new Set<string>(),
                    tokens: [],
                    lastFileEditTurnIndex: -1,
                };
            }
        }

        if (execution) {
            if (snapshot.files.length > 0) {
                for (const file of snapshot.files) execution.files.add(file);
                execution.lastFileEditTurnIndex = index;
            }
            for (const token of snapshot.tokens) execution.tokens.push(token);
        }

        if (idle) {
            closeExecution(idle, index);
        } else if (!hasIdleMarkers) {
            if (turn.completionDisposition !== 'active') {
                closeExecution(undefined, index);
            } else {
                execution = undefined;
            }
        }
    }

    let changed = false;
    const nextTurns = turns.map((turn, index) => {
        const plan = planned[index]!;
        const nextTurnIdleOutcome = plan.turnIdleOutcome;
        const nextTurnDiffFromMessageId = plan.turnDiffFromMessageId;
        const nextTurnDiffFiles = plan.turnDiffFiles;
        const nextTurnDiffSignature = plan.turnDiffSignature;

        const legacyDiffStats = turn.userMessage ? projectTurnDiffStats(turn.userMessage) : undefined;
        const nextDiffStats = legacyDiffStats ?? (nextTurnDiffFiles && nextTurnDiffFiles.length > 0
            ? {
                additions: 0,
                deletions: 0,
                files: nextTurnDiffFiles.length,
                hasDiffs: true,
            }
            : undefined);

        const diffStatsUnchanged = (turn.diffStats === nextDiffStats)
            || Boolean(
                turn.diffStats
                && nextDiffStats
                && turn.diffStats.additions === nextDiffStats.additions
                && turn.diffStats.deletions === nextDiffStats.deletions
                && turn.diffStats.files === nextDiffStats.files
                && turn.diffStats.hasDiffs === nextDiffStats.hasDiffs,
            );

        if (
            turn.turnIdleOutcome === nextTurnIdleOutcome
            && turn.turnDiffFromMessageId === nextTurnDiffFromMessageId
            && turn.turnDiffSignature === nextTurnDiffSignature
            && areStringArraysEqual(turn.turnDiffFiles, nextTurnDiffFiles)
            && diffStatsUnchanged
        ) {
            return turn;
        }

        changed = true;
        return {
            ...turn,
            turnIdleOutcome: nextTurnIdleOutcome,
            turnDiffFromMessageId: nextTurnDiffFromMessageId,
            turnDiffFiles: nextTurnDiffFiles,
            turnDiffSignature: nextTurnDiffSignature,
            diffStats: diffStatsUnchanged ? turn.diffStats : nextDiffStats,
        };
    });

    return changed ? nextTurns : turns;
};

const settleHistoricalActiveTurns = (turns: TurnRecord[]): TurnRecord[] => {
    if (turns.length <= 1) {
        return turns;
    }

    let changed = false;
    const nextTurns = turns.map((turn, index) => {
        const isLastTurn = index === turns.length - 1;
        if (isLastTurn || turn.completionDisposition !== 'active') {
            return turn;
        }
        if ((turns[index + 1]?.assistantMessages.length ?? 0) === 0) {
            return turn;
        }

        changed = true;
        const nextStartedAt = turns[index + 1]?.startedAt;
        let durationMs = turn.durationMs;
        let completedAt = turn.completedAt;
        if (
            typeof durationMs !== 'number'
            && typeof turn.startedAt === 'number'
            && typeof nextStartedAt === 'number'
            && nextStartedAt >= turn.startedAt
        ) {
            completedAt = nextStartedAt;
            durationMs = nextStartedAt - turn.startedAt;
        }

        return {
            ...turn,
            completionDisposition: 'abnormal' as const,
            completedAt,
            durationMs,
            stream: {
                ...turn.stream,
                isStreaming: false,
                completedAt: completedAt ?? turn.stream.completedAt,
                durationMs,
            },
        };
    });

    return changed ? nextTurns : turns;
};

export const projectTurnRecords = (
    messages: ChatMessageEntry[],
    options?: Partial<ProjectTurnRecordsOptions>,
): TurnProjectionResult => {
    const effectiveOptions: ProjectTurnRecordsOptions = {
        ...DEFAULT_OPTIONS,
        ...options,
    };

    const turns: TurnRecord[] = [];
    const turnByUserId = new Map<string, TurnRecord>();
    const noticeOwnerById = new Map<string, TurnRecord>();
    const groupedMessageIds = new Set<string>();

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role === 'compaction' && turns.length > 0) {
            noticeOwnerById.set(message.info.id, turns[turns.length - 1]);
            groupedMessageIds.add(message.info.id);
            return;
        }
        const isLeadingAssistant = role === 'assistant' && turns.length === 0 && !getMessageParentId(message);
        if (role !== 'user' && !isLeadingAssistant) {
            return;
        }
        if (turns.length > 0 && isNativeSyntheticNotice(message)) {
            noticeOwnerById.set(message.info.id, turns[turns.length - 1]);
            groupedMessageIds.add(message.info.id);
            return;
        }

        const turnId = message.info.id;
        const turn: TurnRecord = {
            turnId,
            userMessageId: isLeadingAssistant ? undefined : message.info.id,
            userMessage: isLeadingAssistant ? undefined : message,
            headerMessageId: undefined,
            messages: isLeadingAssistant ? [] : [createTurnMessageRecord(message, index)],
            assistantMessageIds: [],
            assistantMessages: [],
            activityParts: [],
            activitySegments: [],
            summary: {},
            summaryText: undefined,
            hasTools: false,
            hasReasoning: false,
            diffStats: undefined,
            changedFiles: undefined,
            stream: {
                isStreaming: false,
                isRetrying: false,
            },
            completionDisposition: 'active',
            activityPresentationKind: 'default',
            hasConfirmedFinalBody: false,
        };
        turns.push(turn);
        if (turn.userMessageId) {
            turnByUserId.set(turn.userMessageId, turn);
            groupedMessageIds.add(message.info.id);
        }
    });

    let precedingTurn: TurnRecord | undefined = turns[0]?.userMessage ? undefined : turns[0];
    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        const userTurn = turnByUserId.get(message.info.id);
        if (userTurn) precedingTurn = userTurn;
        const noticeOwner = noticeOwnerById.get(message.info.id);
        if (noticeOwner) {
            noticeOwner.messages.push(createTurnMessageRecord(message, index));
            return;
        }
        if (role !== 'assistant') {
            return;
        }

        const parentId = getMessageParentId(message);
        // V2 has no parentID: transcript position, not a wall clock, determines
        // its preceding user. Explicit legacy parents still resolve by identity.
        const targetTurn = parentId ? turnByUserId.get(parentId) : precedingTurn;
        if (!targetTurn) {
            return;
        }

        targetTurn.assistantMessages.push(message);
        targetTurn.assistantMessageIds.push(message.info.id);
        targetTurn.messages.push(createTurnMessageRecord(message, index));
        if (!targetTurn.headerMessageId) {
            targetTurn.headerMessageId = message.info.id;
        }
        groupedMessageIds.add(message.info.id);
    });

    // A truncated leading turn acquires older siblings and eventually its user.
    // Retain the mounted turn identity through that enrichment, not its old data.
    const previousProjection = effectiveOptions.previousProjection;
    if (previousProjection) {
        for (const turn of turns) {
            for (const message of turn.assistantMessages) {
                const previousId = previousProjection.indexes.messageToTurnId.get(message.info.id);
                const previous = previousId ? previousProjection.indexes.turnById.get(previousId) : undefined;
                if (previous && (!previous.userMessage || previous.userMessageId === turn.userMessageId)) {
                    turn.turnId = previous.turnId;
                    if (previous.headerMessageId && turn.assistantMessageIds.includes(previous.headerMessageId)) {
                        turn.headerMessageId = previous.headerMessageId;
                    }
                    break;
                }
            }
        }
    }

    // A leading native notice can own legacy replies, but a notice alone is
    // not a user turn. Otherwise its empty TurnItem inserts a 32px history gap.
    const contentTurns = turns.filter((turn) => {
        if (!turn.userMessage || !isNativeSyntheticNotice(turn.userMessage) || turn.assistantMessages.length > 0) {
            return true;
        }
        for (const record of turn.messages) groupedMessageIds.delete(record.messageId);
        return false;
    });
    const stableTurns = applyV2TurnDiffProjection(
        settleHistoricalActiveTurns(
            hydrateStableTurnRecords(contentTurns, effectiveOptions),
        ),
        effectiveOptions.showTurnChangedFiles,
    );
    const projection = projectTurnIndexes(stableTurns);
    const ungroupedMessageIds = new Set<string>();
    messages.forEach((message) => {
        if (groupedMessageIds.has(message.info.id)) {
            return;
        }
        if (resolveMessageRole(message) === 'assistant') {
            // Explicit parentID that did not resolve: wait for the user turn
            // (pagination). Do not flash orphan replies as standalone rows.
            if (getMessageParentId(message)) {
                return;
            }
            // Native leading assistants already belong to the partial turn.
        }
        ungroupedMessageIds.add(message.info.id);
    });

    return {
        ...projection,
        ungroupedMessageIds,
    };
};
