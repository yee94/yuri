// ---------------------------------------------------------------------------
// Notification store — session turn-complete and error tracking
//
// Tracks session turn-complete and error notifications with viewed/unviewed
// state. Replaces the old sessionAttentionStates polling system.
// ---------------------------------------------------------------------------

import { create } from "zustand"
import type { OpenCodeErrorSummary } from "./session-error-log"
import type { SessionUnreadEntry } from '@/queries/sessionUnreadQueries'

type ReadSync = {
  read: (sessionId: string) => void
  unread: (sessionId: string) => Promise<void>
}
let readSync: ReadSync | null = null
let serverUnread: Record<string, SessionUnreadEntry> | null = null

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationBase = {
  directory?: string
  session?: string
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  /** What OpenCode reported for the failed turn; both null when it gave no details. */
  error?: OpenCodeErrorSummary & { code?: string }
}

export type Notification = TurnCompleteNotification | ErrorNotification

type NotificationIndex = {
  session: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pruneNotifications(list: Notification[]): Notification[] {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function buildIndex(list: Notification[]): NotificationIndex {
  const index: NotificationIndex = {
    session: { unseenCount: {}, unseenHasError: {} },
    project: { unseenCount: {}, unseenHasError: {} },
  }

  for (const n of list) {
    if (n.viewed) continue
    if (serverUnread && n.session) continue

    if (n.session) {
      index.session.unseenCount[n.session] = (index.session.unseenCount[n.session] ?? 0) + 1
      if (n.type === "error") index.session.unseenHasError[n.session] = true
    }
    if (n.directory) {
      index.project.unseenCount[n.directory] = (index.project.unseenCount[n.directory] ?? 0) + 1
      if (n.type === "error") index.project.unseenHasError[n.directory] = true
    }
  }

  if (serverUnread) {
    for (const [id, row] of Object.entries(serverUnread)) {
      if (row.unreadCount === 0) continue
      index.session.unseenCount[id] = row.unreadCount
      if (row.hasError) index.session.unseenHasError[id] = true
      if (row.directory) {
        index.project.unseenCount[row.directory] = (index.project.unseenCount[row.directory] ?? 0) + row.unreadCount
        if (row.hasError) index.project.unseenHasError[row.directory] = true
      }
    }
  }

  return index
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationStore {
  list: Notification[]
  index: NotificationIndex

  // Mutations
  append: (notification: Notification) => void
  markSessionViewed: (sessionId: string) => void
  markProjectViewed: (directory: string) => void

  // Selectors
  sessionUnseenCount: (sessionId: string) => number
  sessionHasError: (sessionId: string) => boolean
  projectUnseenCount: (directory: string) => number
  projectHasError: (directory: string) => boolean
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  list: [],
  index: {
    session: { unseenCount: {}, unseenHasError: {} },
    project: { unseenCount: {}, unseenHasError: {} },
  },

  append: (notification) => {
    const current = get().list
    const next = pruneNotifications([...current, notification])
    set({ list: next, index: buildIndex(next) })
  },

  markSessionViewed: (sessionId) => {
    const current = get()
    readSync?.read(sessionId)
    const count = current.index.session.unseenCount[sessionId] ?? 0
    if (count === 0) return

    const next = current.list.map((n) =>
      n.session === sessionId && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
  },

  markProjectViewed: (directory) => {
    const current = get()
    if (serverUnread) {
      for (const [id, row] of Object.entries(serverUnread)) if (row.directory === directory && row.unreadCount > 0) readSync?.read(id)
    }
    const count = current.index.project.unseenCount[directory] ?? 0
    if (count === 0) return

    const next = current.list.map((n) =>
      n.directory === directory && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
  },

  sessionUnseenCount: (sessionId) => get().index.session.unseenCount[sessionId] ?? 0,
  sessionHasError: (sessionId) => get().index.session.unseenHasError[sessionId] ?? false,
  projectUnseenCount: (directory) => get().index.project.unseenCount[directory] ?? 0,
  projectHasError: (directory) => get().index.project.unseenHasError[directory] ?? false,
}))

// ---------------------------------------------------------------------------
// Imperative API for non-React code (event handler in sync-context)
// ---------------------------------------------------------------------------

export function appendNotification(notification: Notification) {
  useNotificationStore.getState().append(notification)
}

export function markSessionViewed(sessionId: string) {
  useNotificationStore.getState().markSessionViewed(sessionId)
}

/** Query owns the snapshot; this store keeps the existing narrow badge selectors. */
export function applySessionUnreadSnapshot(sessions: Record<string, SessionUnreadEntry>) {
  if (serverUnread === sessions) return
  serverUnread = sessions
  useNotificationStore.setState({ index: buildIndex(useNotificationStore.getState().list) })
}

export function installSessionReadSync(sync: ReadSync) {
  readSync = sync
  return () => { if (readSync === sync) readSync = null }
}

export function resetSessionUnreadProjection() {
  serverUnread = null
  useNotificationStore.setState({ list: [], index: buildIndex([]) })
}

export async function markSessionUnread(sessionId: string, directory?: string) {
  if (readSync) return readSync.unread(sessionId)
  if (useNotificationStore.getState().sessionUnseenCount(sessionId) > 0) return
  appendNotification({ session: sessionId, directory, time: Date.now(), viewed: false, type: 'turn-complete' })
}

/**
 * Drop live error notifications for one session when a new authoritative run
 * starts (`session.execution.started` / status busy). Keeps turn-complete rows.
 * Scoped by session id only — does not touch other sessions or directories.
 */
export function clearSessionErrorNotifications(sessionId: string): void {
  if (!sessionId) return
  const current = useNotificationStore.getState().list
  let changed = false
  const next = current.filter((notification) => {
    if (notification.session === sessionId && notification.type === "error") {
      changed = true
      return false
    }
    return true
  })
  if (!changed) return
  useNotificationStore.setState({ list: next, index: buildIndex(next) })
}

// ---------------------------------------------------------------------------
// React hooks for fine-grained subscriptions
// ---------------------------------------------------------------------------

export function useSessionUnseenCount(sessionId: string): number {
  return useNotificationStore((s) => s.index.session.unseenCount[sessionId] ?? 0)
}

/** The newest error OpenCode reported for this session, viewed or not. */
export function useLatestSessionError(sessionId: string): ErrorNotification | null {
  return useNotificationStore((s) => {
    if (!sessionId) return null
    for (let index = s.list.length - 1; index >= 0; index -= 1) {
      const notification = s.list[index]
      if (notification.session === sessionId && notification.type === "error") return notification
    }
    return null
  })
}
