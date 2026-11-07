export const SESSION_COMPACTION_STATUSES = ["running", "completed", "failed"] as const
export type SessionCompactionStatus = (typeof SESSION_COMPACTION_STATUSES)[number]
export type SessionCompactionReason = "auto" | "manual"

export type SessionCompactionPart = {
  id: string
  sessionID: string
  messageID: string
  type: "compaction"
  status: SessionCompactionStatus
  reason: SessionCompactionReason
  summary?: string
  recent?: string
  error?: { type: string; message: string; status?: number }
}

export function isSessionCompactionCard(part: unknown): part is SessionCompactionPart {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return false
  const value = part as Record<string, unknown>
  if (value.type !== "compaction") return false
  return value.status === "running" || value.status === "completed" || value.status === "failed"
}

export function getSessionCompactionCard(
  parts: readonly unknown[] | undefined,
): SessionCompactionPart | undefined {
  if (!parts) return undefined
  return parts.find(isSessionCompactionCard)
}
