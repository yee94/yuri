import { afterEach, describe, expect, test, vi } from "vitest"
import type { OpenCodeClient } from "@/lib/opencode/v2-types"
import { bootstrapDirectory, bootstrapDirectoryWithRecovery, bootstrapGlobal } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"

vi.mock("./sync-refs", () => ({ emitSyncConfigChanged: vi.fn() }))
const transport = vi.hoisted(() => ({ runtimeFetch: vi.fn() }))
vi.mock("../lib/runtime-fetch", () => transport)

afterEach(() => vi.restoreAllMocks())

describe("global bootstrap without implicit location demand", () => {
  test("checks global readiness without booting default/home services or clearing seeds", async () => {
    const unexpected = vi.fn(async () => { throw new Error("implicit location boot") })
    const sdk = {
      server: { info: vi.fn(async () => ({ version: "2.0.23" })) },
      location: { get: unexpected }, config: { get: unexpected }, project: { list: unexpected },
    }
    const set = vi.fn()
    await bootstrapGlobal(sdk as unknown as OpenCodeClient, set)
    expect(sdk.server.info).toHaveBeenCalledOnce()
    expect(unexpected).not.toHaveBeenCalled()
    expect(set.mock.calls).toEqual([[{ ready: true, error: undefined }]])
  })

  test("retains actionable host startup error when the global probe fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    transport.runtimeFetch.mockResolvedValue(new Response(JSON.stringify({ lastOpenCodeError: "Service authentication failed" }), { status: 200 }))
    const sdk = { server: { info: vi.fn(async () => { throw new Error("unauthorized") }) } }
    const set = vi.fn()
    await bootstrapGlobal(sdk as unknown as OpenCodeClient, set)
    expect(set).toHaveBeenLastCalledWith({ ready: true, error: { type: "init", message: "Service authentication failed" } })
  })

  test("does not start default services for an empty directory", async () => {
    await expect(bootstrapDirectory({ directory: " ", sdk: {} as OpenCodeClient, getState: () => INITIAL_STATE,
      set: vi.fn(), global: { config: {}, projects: [] },
    })).rejects.toThrow("explicit directory")
  })
})

describe("directory bootstrap deferred services", () => {
  test.each([false, true])("keeps real errors visible without an unavailable LSP failure (VCS failure: %s)", async (failVcs) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const vcsError = new Error("VCS access denied")
    let state: State = { ...INITIAL_STATE }
    const sdk = {
      location: { get: vi.fn(async () => ({ directory: "/repo", project: { id: "project_1", directory: "/repo" } })) },
      config: { get: vi.fn(async () => []) },
      session: { active: async () => ({}) },
      vcs: { get: async () => {
        if (failVcs) throw vcsError
        return { data: { branch: "main" } }
      } },
      form: { list: vi.fn(async () => ({ data: [] })) },
      permission: { request: { list: vi.fn(async () => ({ data: [] })) } },
    }
    await bootstrapDirectory({
      directory: "/repo",
      sdk: sdk as unknown as OpenCodeClient,
      getState: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      global: { config: {}, projects: [] },
    })
    // Deferred allSettled must finish before checking its diagnostics.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.status).toBe("complete")
    expect(state.project).toBe("project_1")
    expect(state.path.directory).toBe("/repo")
    expect(sdk.location.get).toHaveBeenCalledWith({ location: { directory: "/repo" } })
    expect(sdk.config.get).toHaveBeenCalledWith({ location: { directory: "/repo" } })
    expect(sdk.form.list).toHaveBeenCalledOnce()
    expect(sdk.permission.request.list).toHaveBeenCalledOnce()
    if (failVcs) {
      expect(error).toHaveBeenCalledExactlyOnceWith("[bootstrap] deferred phase failed for /repo", vcsError)
    } else {
      expect(state.vcs).toEqual({ branch: "main" })
      expect(error).not.toHaveBeenCalled()
    }
  })
})

describe("directory bootstrap recovery", () => {
  const notFound = () => Object.assign(new Error("Location not found: /repo"), { _tag: "LocationNotFoundError", status: 404 })
  const setup = (failures: number) => {
    let state: State = { ...INITIAL_STATE }
    let calls = 0
    const sdk = {
      location: { get: vi.fn(async () => {
        if (calls < failures) throw notFound()
        return { directory: "/repo", project: { id: "project_1", directory: "/repo" } }
      }) },
      config: { get: vi.fn(async () => []) },
      session: { active: async () => ({}) },
      vcs: { get: async () => ({ data: { branch: "main" } }) },
      form: { list: async () => ({ data: [] }) },
      permission: { request: { list: async () => ({ data: [] }) } },
    }
    const input = {
      directory: "/repo",
      sdk: sdk as unknown as OpenCodeClient,
      getState: () => state,
      set: (patch: Partial<State>) => { state = { ...state, ...patch } },
      global: { config: {}, projects: [] },
    }
    const sleep = vi.fn(async () => { calls += 1 })
    return { input, sleep, sdk, state: () => state }
  }

  test("retries a non-transient host failure until the directory completes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { input, sleep, state } = setup(2)
    await bootstrapDirectoryWithRecovery(input, { shouldContinue: () => true, sleep, delays: [1, 2, 3] })
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(state().status).toBe("complete")
    expect(state().project).toBe("project_1")
  })

  test("stops after the bounded delays and leaves the failure visible", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { input, sleep, state } = setup(Number.POSITIVE_INFINITY)
    await bootstrapDirectoryWithRecovery(input, { shouldContinue: () => true, sleep, delays: [1, 2] })
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(state().status).toBe("partial")
  })

  test("does not retry once the directory is no longer current", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { input, sleep, sdk } = setup(Number.POSITIVE_INFINITY)
    await bootstrapDirectoryWithRecovery(input, { shouldContinue: () => false, sleep, delays: [1, 2, 3] })
    expect(sleep).toHaveBeenCalledTimes(1)
    const afterFirst = sdk.config.get.mock.calls.length
    expect(afterFirst).toBe(1)
  })
})
