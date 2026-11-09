export type TurnOffsetTarget =
    | { kind: 'noop' }
    | { kind: 'resume' }
    | { kind: 'turn'; turnId: string };

export const resolveTurnOffsetTarget = (
    turnIds: readonly string[],
    activeTurnId: string | null,
    offset: number,
): TurnOffsetTarget => {
    if (offset === 0 || turnIds.length === 0) return { kind: 'noop' };
    const baseIndex = activeTurnId ? turnIds.indexOf(activeTurnId) : turnIds.length - 1;
    const normalizedBase = baseIndex >= 0 ? baseIndex : turnIds.length - 1;
    const targetIndex = normalizedBase + offset;
    if (targetIndex >= turnIds.length) return { kind: 'resume' };
    const targetTurnId = turnIds[Math.max(0, targetIndex)];
    return targetTurnId ? { kind: 'turn', turnId: targetTurnId } : { kind: 'noop' };
};
