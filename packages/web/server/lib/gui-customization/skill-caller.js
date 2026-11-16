const validID = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** A bridge caller is exactly one admitted Session or one live Assistant contact. */
export const parseSkillCaller = (body) => {
  const { sessionID, assistantID } = body ?? {};
  if (validID(sessionID) && assistantID === undefined) return { kind: 'session', id: sessionID };
  if (validID(assistantID) && sessionID === undefined) return { kind: 'assistant', id: assistantID };
  return null;
};

const hostOriginOf = (req) => `http://${req.socket.localAddress === '::1' ? '[::1]' : '127.0.0.1'}:${req.socket.localPort}`;

/** Loopback and service credential are checked by the route; this binds the caller to this Host. */
export const isBoundSkillCaller = async (req, caller, { createClient, hasAssistant }) => {
  if (caller.kind === 'assistant') return Boolean(await hasAssistant?.(caller.id));
  const session = await createClient().session.get({ sessionID: caller.id });
  return session.metadata?.yuri?.scheduledTaskSkill?.hostOrigin === hostOriginOf(req);
};
