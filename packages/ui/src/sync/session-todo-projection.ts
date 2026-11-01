import type { Part, Todo } from '@/lib/opencode/v2-types'

import type { StoreApi } from "zustand"

import { useTodosPersistStore } from "@/stores/useTodosPersistStore"
import type { DirectoryStore } from "./child-store"
import type { TranscriptData } from "./transcript-repository"
import {
  getTranscriptRepository,
  transcriptScope,
} from "./transcript-repository-runtime"

const TODO_TOOL_NAMES = new Set(["todowrite", "todoread"])
const REJECTED_TOOL_STATUSES = new Set([
  "error",
  "aborted",
  "failed",
  "cancelled",
  "canceled",
  "timeout",
])

type TranscriptTodoSource = Pick<TranscriptData, "messageOrder" | "partsByMessageID">

type SeedSessionTodosInput = {
  sessionID: string
  store: StoreApi<DirectoryStore>
  transcript: TranscriptTodoSource
  persist?: (sessionID: string, todos: Todo[]) => void
  isStale?: () => boolean
}

type SeedHydratedSessionTodosInput = {
  directory: string
  sessionID: string
  store: StoreApi<DirectoryStore>
  transcript?: TranscriptTodoSource
  isStale?: () => boolean
}

const hasLiveTodoRecord = (todo: Record<string, Todo[]>, sessionID: string): boolean => (
  Object.prototype.hasOwnProperty.call(todo, sessionID)
)

const persistSessionTodos = (sessionID: string, todos: Todo[]): void => {
  useTodosPersistStore.getState().setSessionTodos(sessionID, todos)
}

const readToolName = (part: Part): string => {
  if (part.type !== "tool") return ""
  const tool = (part as { tool?: unknown }).tool
  return typeof tool === "string" ? tool.trim().toLowerCase() : ""
}

const readToolStatus = (part: Part): string | undefined => {
  const state = (part as { state?: { status?: unknown } }).state
  return typeof state?.status === "string" ? state.status.trim().toLowerCase() : undefined
}

const normalizeTodo = (value: unknown): Todo | null => {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.content !== "string" || typeof record.status !== "string") return null
  const todo: Todo & { id?: string } = {
    content: record.content,
    status: record.status,
    priority: typeof record.priority === "string" ? record.priority : "medium",
  }
  if (typeof record.id === "string" && record.id.length > 0) {
    todo.id = record.id
  }
  return todo
}

const normalizeTodoList = (value: unknown): Todo[] => {
  if (!Array.isArray(value)) return []
  const todos: Todo[] = []
  for (const entry of value) {
    const todo = normalizeTodo(entry)
    if (todo) todos.push(todo)
  }
  return todos
}

const parseJsonTodos = (value: string): Todo[] => {
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return normalizeTodoList(parsed)
    if (parsed && typeof parsed === "object") {
      return normalizeTodoList((parsed as { todos?: unknown }).todos)
    }
  } catch {
    // Ignore non-JSON tool output.
  }
  return []
}

const readTodosFromPart = (part: Part): Todo[] => {
  if (!TODO_TOOL_NAMES.has(readToolName(part))) return []
  const status = readToolStatus(part)
  if (status && REJECTED_TOOL_STATUSES.has(status)) return []

  const state = (part as {
    state?: {
      input?: { todos?: unknown }
      output?: unknown
    }
  }).state

  const fromInput = normalizeTodoList(state?.input?.todos)
  if (fromInput.length > 0) return fromInput

  const output = state?.output
  if (Array.isArray(output)) {
    const fromOutput = normalizeTodoList(output)
    if (fromOutput.length > 0) return fromOutput
  }
  if (output && typeof output === "object") {
    const fromOutputObject = normalizeTodoList((output as { todos?: unknown }).todos)
    if (fromOutputObject.length > 0) return fromOutputObject
  }
  if (typeof output === "string" && output.trim().length > 0) {
    return parseJsonTodos(output)
  }
  return []
}

/**
 * Latest usable `todowrite` input in a message-record list (already cut at
 * the revert boundary). OpenCode v2 keeps no todo state server-side and emits
 * no `todo.updated`, so the list is derived from the transcript itself.
 * A running `todowrite` already carries the authoritative list, including
 * `in_progress`, and must count; otherwise the row keeps a stale or empty
 * presented set until the tool settles. An explicit empty list clears; failed
 * or aborted calls are skipped.
 */
export function projectTodosFromMessageRecords(
  records: ReadonlyArray<{ info: { id: string }; parts?: unknown[] }>,
): Todo[] | undefined {
  const part = findLatestTodoListPart(records.map((record) => record.parts as Part[] | undefined))
  if (!part) return undefined
  return normalizeTodoList((part as { state?: { input?: { todos?: unknown } } }).state?.input?.todos)
}

/** Rejected, settled, or still running `todowrite` parts all contribute. */
const isUsableTodoListPart = (part: Part): boolean => (
  readToolName(part) === "todowrite" && !REJECTED_TOOL_STATUSES.has(readToolStatus(part) ?? "")
)

const findLatestTodoListPart = (partsByMessage: ReadonlyArray<readonly Part[] | undefined>): Part | undefined => {
  for (let index = partsByMessage.length - 1; index >= 0; index -= 1) {
    const parts = partsByMessage[index]
    if (!parts) continue
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]!
      if (!isUsableTodoListPart(part)) continue
      if (Array.isArray((part as { state?: { input?: { todos?: unknown } } }).state?.input?.todos)) return part
    }
  }
  return undefined
}

const normalizedTodoCache = new WeakMap<object, Todo[]>()

/**
 * Same projection as `projectTodosFromMessageRecords`, but reads the raw
 * transcript and returns a reference that only changes when the source
 * `todowrite` input changes. Streaming text deltas therefore yield an
 * identical snapshot and cause no re-render in subscribers.
 */
export function projectLatestTodosFromTranscript(
  transcript: TranscriptTodoSource,
  revertMessageID?: string,
): Todo[] | undefined {
  const order = transcript.messageOrder
  let end = order.length
  if (revertMessageID) {
    const cut = order.indexOf(revertMessageID)
    if (cut >= 0) end = cut
  }
  const part = findLatestTodoListPart(order.slice(0, end).map((messageID) => transcript.partsByMessageID[messageID]))
  if (!part) return undefined
  const input = (part as { state?: { input?: { todos?: unknown } } }).state?.input?.todos
  if (!Array.isArray(input)) return undefined
  let normalized = normalizedTodoCache.get(input)
  if (!normalized) {
    normalized = normalizeTodoList(input)
    normalizedTodoCache.set(input, normalized)
  }
  return normalized
}

/**
 * Walk the loaded transcript newest-first and return the latest usable
 * todowrite/todoread list. Does not fetch; callers already hydrated messages.
 */
export function projectTodosFromTranscript(transcript: TranscriptTodoSource): Todo[] {
  for (let index = transcript.messageOrder.length - 1; index >= 0; index -= 1) {
    const messageID = transcript.messageOrder[index]
    const parts = transcript.partsByMessageID[messageID]
    if (!parts || parts.length === 0) continue
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const todos = readTodosFromPart(parts[partIndex]!)
      if (todos.length > 0) return todos
    }
  }
  return []
}

/**
 * Fill `store.todo[sessionID]` from a hydrated transcript when live SSE never
 * wrote this session. Occupied keys — including an explicit empty list — win.
 */
export function seedSessionTodosFromTranscript(input: SeedSessionTodosInput): boolean {
  if (!input.sessionID || input.isStale?.()) return false
  if (hasLiveTodoRecord(input.store.getState().todo, input.sessionID)) return false

  const todos = projectTodosFromTranscript(input.transcript)
  if (todos.length === 0 || input.isStale?.()) return false
  if (hasLiveTodoRecord(input.store.getState().todo, input.sessionID)) return false

  input.store.setState((state) => ({
    todo: {
      ...state.todo,
      [input.sessionID]: todos,
    },
  }))
  input.persist?.(input.sessionID, todos)
  return true
}

/**
 * Hydrate-path entry: resolve the bound transcript (or an injected page) and
 * seed directory + persist stores. No extra HTTP.
 */
export function seedSessionTodosFromHydratedTranscript(
  input: SeedHydratedSessionTodosInput,
): boolean {
  if (!input.sessionID || !input.directory || input.isStale?.()) return false
  const transcript = input.transcript ?? getTranscriptRepository()?.getTranscript(
    transcriptScope(input.directory, input.sessionID),
  )
  if (!transcript) return false
  return seedSessionTodosFromTranscript({
    sessionID: input.sessionID,
    store: input.store,
    transcript,
    persist: persistSessionTodos,
    isStale: input.isStale,
  })
}
