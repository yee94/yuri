import { describe, expect, mock, test } from "bun:test"
import React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"

let renderCustomToast: ((id: string | number) => React.ReactElement) | undefined
const unarchivedIds: string[] = []

mock.module("@/components/ui/toast", () => ({
  toast: {
    custom: (render: (id: string | number) => React.ReactElement) => {
      renderCustomToast = render
      return "toast-id"
    },
    dismiss: () => undefined,
    error: () => undefined,
  },
}))

mock.module("@/stores/useUIStore", () => ({
  useUIStore: {
    getState: () => ({ setArchivedSessionsDialogOpen: () => undefined }),
  },
}))

mock.module("@/sync/session-actions", () => ({
  SESSION_DELETE_UNDO_MS: 10_000,
  cancelScheduledSessionDeletes: () => undefined,
  scheduleSessionDeletes: () => ({ batchId: "", scheduledIds: [] }),
  unarchiveSession: async (id: string) => {
    unarchivedIds.push(id)
    return true
  },
}))

const { showArchivedSessionsUndoToast } = await import("./sessionMutationUndo")

describe("session mutation undo toast", () => {
  test("keeps custom content inside the padded toast on narrow screens", () => {
    showArchivedSessionsUndoToast({
      sessionIds: ["session-1"],
      message: "Session archived",
      undoLabel: "Undo",
      settingsLabel: "View archived",
      undoFailedMessage: "Undo failed",
    })

    expect(renderCustomToast).toBeDefined()
    const html = renderToString(renderCustomToast!("toast-id"))

    expect(html).toContain("w-full min-w-0 max-w-full")
    expect(html).toContain("flex-1 truncate")
  })

  test("undo runs the caller's restore together with the unarchive", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    unarchivedIds.length = 0
    let undoCalls = 0
    const onUndo = () => {
      undoCalls += 1
    }
    showArchivedSessionsUndoToast({
      sessionIds: ["session-1"],
      message: "Session archived",
      undoLabel: "Undo",
      settingsLabel: "View archived",
      undoFailedMessage: "Undo failed",
      onUndo,
    })

    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(renderCustomToast!("toast-id")))
    const undo = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Undo"))
    await act(async () => undo?.click())

    expect(undoCalls).toBe(1)
    expect(unarchivedIds).toEqual(["session-1"])
    await act(async () => root.unmount())
    container.remove()
  })
})
