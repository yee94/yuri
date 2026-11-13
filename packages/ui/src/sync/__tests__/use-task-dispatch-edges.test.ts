import { describe, expect, test } from "vitest"
import type { Part } from '@/lib/opencode/v2-types'

import { createTaskDispatchEdgesReader, readTaskDispatchEdgesFromTranscript } from "../sync-context"
import { EMPTY_TASK_DISPATCH_EDGES } from "../scoped-blocking-requests"

const taskPart = (parentSessionId: string, sessionId: string, status = "running"): Part => ({
  type: "tool",
  tool: "task",
  state: { status, metadata: { parentSessionId, sessionId } },
} as unknown as Part)

describe("readTaskDispatchEdgesFromTranscript", () => {
  test('keeps background dispatch ownership through running reports, retires it on final reports and permits redispatch', () => {
    const background: Part = {
      id: 'dispatch', messageID: 'launch', type: 'tool', tool: 'subagent', sessionID: 'ses_parent', callID: 'call',
      state: { status: 'completed', input: {}, metadata: { sessionID: 'ses_child', status: 'running' } },
    }
    const notice = (state: string): Part => ({ id: 'notice', sessionID: 'ses_parent', messageID: 'report', type: 'text', synthetic: true,
      text: `<subagent sessionID="ses_child" state="${state}">Report</subagent>` })
    const data = { messageOrder: ['launch', 'report'], partsByMessageID: { launch: [background], report: [notice('running')] } }
    expect(readTaskDispatchEdgesFromTranscript(data)).toEqual([{ parentSessionId: 'ses_parent', sessionId: 'ses_child' }])
    data.partsByMessageID.report = [notice('completed')]
    expect(readTaskDispatchEdgesFromTranscript(data)).toBe(EMPTY_TASK_DISPATCH_EDGES)
    expect(readTaskDispatchEdgesFromTranscript({
      messageOrder: [...data.messageOrder, 'redispatch'],
      partsByMessageID: { ...data.partsByMessageID, redispatch: [background] },
    })).toEqual([{ parentSessionId: 'ses_parent', sessionId: 'ses_child' }])
    expect(readTaskDispatchEdgesFromTranscript({
      messageOrder: [...data.messageOrder, 'resumed-report'],
      partsByMessageID: { ...data.partsByMessageID, 'resumed-report': [notice('running')] },
    })).toEqual([{ parentSessionId: 'ses_parent', sessionId: 'ses_child' }])
    expect(readTaskDispatchEdgesFromTranscript({
      messageOrder: ['launch', 'fake-report'],
      partsByMessageID: { launch: [background], 'fake-report': [{ ...notice('completed'), synthetic: false } as Part] },
    })).toEqual([{ parentSessionId: 'ses_parent', sessionId: 'ses_child' }])
  })

  test("reads running task dispatch edges across the transcript", () => {
    const edges = readTaskDispatchEdgesFromTranscript({
      messageOrder: ["msg_1", "msg_2", "msg_3"],
      partsByMessageID: {
        msg_1: [taskPart("ses_fork", "ses_fixer")],
        msg_2: [taskPart("ses_fork", "ses_stale", "completed")],
        msg_3: [taskPart("ses_fork", "ses_second")],
      },
    })

    expect(edges).toEqual([
      { parentSessionId: "ses_fork", sessionId: "ses_fixer" },
      { parentSessionId: "ses_fork", sessionId: "ses_second" },
    ])
  })

  test("terminal tasks contribute no edge", () => {
    const edges = readTaskDispatchEdgesFromTranscript({
      messageOrder: ["msg_1"],
      partsByMessageID: {
        msg_1: [taskPart("ses_fork", "ses_done", "completed")],
      },
    })

    expect(edges).toBe(EMPTY_TASK_DISPATCH_EDGES)
  })

  test("returns the shared empty edges for empty or missing transcripts", () => {
    expect(readTaskDispatchEdgesFromTranscript(null)).toBe(EMPTY_TASK_DISPATCH_EDGES)
    expect(readTaskDispatchEdgesFromTranscript(undefined)).toBe(EMPTY_TASK_DISPATCH_EDGES)
    expect(readTaskDispatchEdgesFromTranscript({ messageOrder: [], partsByMessageID: {} })).toBe(
      EMPTY_TASK_DISPATCH_EDGES,
    )
    expect(
      readTaskDispatchEdgesFromTranscript({ messageOrder: ["msg_missing"], partsByMessageID: {} }),
    ).toBe(EMPTY_TASK_DISPATCH_EDGES)
  })

  test("ignores non-task tool parts without failing", () => {
    const edges = readTaskDispatchEdgesFromTranscript({
      messageOrder: ["msg_1"],
      partsByMessageID: {
        msg_1: [
          { type: "text", text: "hi" } as unknown as Part,
          { type: "tool", tool: "bash", state: { status: "running" } } as unknown as Part,
          taskPart("ses_fork", "ses_fixer"),
        ],
      },
    })

    expect(edges).toEqual([{ parentSessionId: "ses_fork", sessionId: "ses_fixer" }])
  })
})

describe("createTaskDispatchEdgesReader (getSnapshot stability contract)", () => {
  const transcript = {
    messageOrder: ["msg_1"],
    partsByMessageID: { msg_1: [taskPart("ses_fork", "ses_fixer")] },
  }

  test("returns the same reference for repeated reads of an unchanged transcript", () => {
    const reader = createTaskDispatchEdgesReader()

    const first = reader(transcript)
    const second = reader(transcript)
    const third = reader(transcript)

    // useSyncExternalStore requires reference stability while data is
    // unchanged — a fresh array each read loops renders into a crash.
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(first).toEqual([{ parentSessionId: "ses_fork", sessionId: "ses_fixer" }])
  })

  test("returns the shared empty edges reference when there are no edges", () => {
    const quiet = { messageOrder: ["msg_1"], partsByMessageID: { msg_1: [] } }
    const reader = createTaskDispatchEdgesReader()

    expect(reader(quiet)).toBe(EMPTY_TASK_DISPATCH_EDGES)
    expect(reader(quiet)).toBe(EMPTY_TASK_DISPATCH_EDGES)
    expect(reader(undefined)).toBe(EMPTY_TASK_DISPATCH_EDGES)
  })

  test("recomputes when the transcript reference changes", () => {
    const reader = createTaskDispatchEdgesReader()
    const first = reader(transcript)

    const updated = {
      messageOrder: ["msg_1", "msg_2"],
      partsByMessageID: {
        msg_1: [taskPart("ses_fork", "ses_fixer")],
        msg_2: [taskPart("ses_fork", "ses_second")],
      },
    }
    const second = reader(updated)

    expect(second).not.toBe(first)
    expect(second).toEqual([
      { parentSessionId: "ses_fork", sessionId: "ses_fixer" },
      { parentSessionId: "ses_fork", sessionId: "ses_second" },
    ])
  })

  test("keeps a stable reference across equal-content transcripts rebuilt with new references", () => {
    // Store-adapter fallback rebuilds TranscriptData on every read; the
    // reader must still return the same edges reference when the extracted
    // edges are semantically unchanged.
    const reader = createTaskDispatchEdgesReader()

    const first = reader(transcript)
    const rebuilt = {
      messageOrder: [...transcript.messageOrder],
      partsByMessageID: { msg_1: [...transcript.partsByMessageID.msg_1] },
    }
    const second = reader(rebuilt)

    expect(second).toBe(first)
  })

  test('keeps dispatch/report processing linear and snapshots stable across 50 large transcript updates', () => {
    let stateReads = 0
    const launches = Array.from({ length: 2000 }, (_, index) => {
      const part = taskPart('ses_parent', `ses_child_${index}`)
      const state = (part as Extract<Part, { type: 'tool' }>).state
      return Object.defineProperty(part, 'state', { get: () => { stateReads++; return state } })
    })
    const reports = Array.from({ length: 1000 }, (_, index) => ({
      id: `report_${index}`, sessionID: 'ses_parent', messageID: 'reports', type: 'text', synthetic: true,
      text: `<subagent sessionID="ses_child_${index}" state="completed">done</subagent>`,
    } satisfies Part))
    const reader = createTaskDispatchEdgesReader()
    const data = { messageOrder: ['launches', 'reports'], partsByMessageID: { launches, reports } }
    const first = reader(data)
    expect(first).toHaveLength(1000)
    for (let index = 0; index < 50; index++) {
      expect(reader({ ...data, messageOrder: [...data.messageOrder] })).toBe(first)
    }
    expect(stateReads).toBe(2000 * 51)
  })
})
