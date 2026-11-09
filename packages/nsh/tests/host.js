/** Native engine UI fixture. Never selected by production nsh.json or the iOS Host. */
export function assertFixtureRequestScope(input, runtimeScope) {
  if (input.expectedHost && (input.expectedHost.hostID !== runtimeScope.hostID || input.expectedHost.lease !== runtimeScope.lease)) throw new Error('Stale synthetic chat scope');
  if ((input.method ?? 'GET') !== 'GET' && (!input.expectedHost || input.expectedHost.hostID !== runtimeScope.hostID || input.expectedHost.lease !== runtimeScope.lease)) throw new Error('Missing synthetic chat scope');
}
export function createHost() {
  let sent = false;
  let selectedModel = { id: 'Native test model', providerID: 'fixture' };
  let selectedAgent = 'build';
  const runtimeScope = { hostID: 'fixture', lease: 'synthetic-chat-lease' };
  const cleanupOwner = 'synthetic-cache-root';
  return {
    call(name, input) {
      if (name.startsWith('authorization.cache.')) {
        const keys = Object.keys(input ?? {});
        if (name === 'authorization.cache.ready' && keys.length === 0) return { owner: cleanupOwner, tickets: [] };
        if (name === 'authorization.cache.list' && keys.length === 1 && input.owner === cleanupOwner) return [];
        if (name === 'authorization.cache.retry' && keys.length === 0) return true;
        throw new Error('Invalid synthetic authorization cache request');
      }
      if (name === "connection.list")
        return {
          selected: "fixture",
          runtimeScope,
          connections: [
            {
              id: "fixture",
              label: "Test Host",
              url: "https://host.example",
              lastUsedAt: 1,
            },
          ],
        };
      if (name === "runtime.stop" || name === "runtime.stream") return true;
      if (name !== "runtime.request")
        throw new Error("Unexpected native call: " + name);
      const path = input.path;
      assertFixtureRequestScope(input, runtimeScope);
      let body;
      if (path === "/api/config/settings")
        body = {
          projects: [
            { id: "p1", name: "Native workspace", path: "/workspace/project" },
          ],
        };
      else if (path === "/api/yuri/session-index")
        body = {
          available: true,
          directories: [
            {
              directory: "/workspace/project",
              sessions: [
                {
                  id: "ses_1",
                  title: "Native conversation",
                  time: { updated: 2 },
                },
              ],
            },
          ],
        };
      else if (path === "/api/yuri/assistants/snapshot")
        body = {
          assistants: [
            {
              id: "bot_1",
              name: "Native Bot",
              effectiveWorkspacePath: "/workspace/project",
              modelID: "test-model",
            },
          ],
        };
      else if (path.startsWith('/api/config/catalog/providers')) body = { schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture provider', models: {
        'Native test model': { id: 'Native test model', name: 'Native test model', variants: { low: {}, high: {} } },
        'second-model': { id: 'second-model', name: 'Second native model', variants: { low: {}, high: {} } },
      } }] };
      else if (path.startsWith('/api/agent?')) body = { data: [{ id: 'build', name: 'Build', mode: 'primary' }, { id: 'plan', name: 'Plan', mode: 'primary' }, { id: 'child', name: 'Hidden subagent', mode: 'subagent' }] };
      else if (path.startsWith('/api/session/ses_1/model?') && input.method === 'POST') { selectedModel = input.body.model; body = { data: { model: selectedModel } }; }
      else if (path.startsWith('/api/session/ses_1/agent?') && input.method === 'POST') { selectedAgent = input.body.agent; body = { data: { agent: selectedAgent } }; }
      else if (path === "/api/yuri/scheduled-tasks")
        body = { tasks: [], failedProjectIds: [] };
      else if (path.startsWith('/api/git/status?')) body = { isClean: true, files: [] };
      else if (path.startsWith('/api/git/remotes?')) body = [];
      else if (path.startsWith("/api/session/ses_1/message"))
        body = {
          data: [
            {
              id: "msg_a",
              type: "assistant",
              content: [
                {
                  type: "text",
                  text: sent
                    ? "Message accepted by native transport"
                    : "Hello from the native engine",
                },
              ],
            },
          ],
          complete: true,
        };
      else if (path.startsWith("/api/session/ses_1/inbox")) body = { data: [] };
      else if (path.startsWith("/api/session/ses_1/prompt")) {
        sent = true;
        body = {
          id: input.body.id,
          sessionID: "ses_1",
          type: "user",
          delivery: input.body.delivery,
          payload: { text: input.body.text },
        };
      } else if (path === '/api/session/active') body = { data: {} };
      else if (path.includes("/permission") || path.includes("/form"))
        body = { data: [] };
      else if (path === "/api/session/ses_1" || path.startsWith('/api/session/ses_1?'))
        body = { data: { id: "ses_1", execution: { type: "idle" }, model: selectedModel, agent: selectedAgent } };
      else throw new Error("Unexpected request: " + path);
      return { status: 200, body };
    },
  };
}
