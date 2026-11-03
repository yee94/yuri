/**
 * Channel admission creates these reserved input IDs; contact turnID persists
 * that exact ID on every reply. Never infer reply routing from the latest input.
 */
export function isMessageChannelTurn(turnID) {
  return typeof turnID === 'string' && (turnID.startsWith('weixin:') || turnID.startsWith('channel:'));
}
