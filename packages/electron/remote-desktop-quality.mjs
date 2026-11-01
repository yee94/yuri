// These are encoder ceilings, not reserved bandwidth. Chromium still owns congestion control.
const VIDEO_QUALITY = [
  { maxBitrate: 350000, maxFramerate: 8, scaleResolutionDownBy: 3 },
  { maxBitrate: 750000, maxFramerate: 12, scaleResolutionDownBy: 2 },
  { maxBitrate: 1500000, maxFramerate: 20, scaleResolutionDownBy: 1.5 },
  { maxBitrate: 3000000, maxFramerate: 30, scaleResolutionDownBy: 1 },
].map(Object.freeze);
const ZOOM_QUALITY = VIDEO_QUALITY.map((value, index) => Object.freeze({ ...value,
  maxFramerate: [2, 5, 10, 15][index], scaleResolutionDownBy: 1, degradationPreference: 'maintain-resolution',
}));
const nonnegative = value => Number.isFinite(value) && value >= 0;
function sameBytes(left, right) {
  if (left?.length !== right.length) return false;
  for (let i = 0; i < right.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

export function createVideoQualityController() {
  let level = 2, bad = 0, good = 0, baselineRtt = Infinity, zoomed = false;
  let previousOutbound, previousRemote;
  const current = () => (zoomed ? ZOOM_QUALITY : VIDEO_QUALITY)[level];
  const unknown = () => { bad = good = 0; return current(); };
  return {
    get current() { return current(); },
    setZoomed(value) { zoomed = value; return current(); },
    sample(stats) {
      const outbound = [...stats.values()].find(item => item.type === 'outbound-rtp' && item.kind === 'video');
      if (!outbound || !nonnegative(outbound.timestamp) || !(outbound.bytesSent > 0)) return unknown();
      if (previousOutbound?.id !== outbound.id) {
        bad = good = 0; baselineRtt = Infinity; previousRemote = undefined;
      } else if (outbound.timestamp <= previousOutbound.timestamp || (outbound.bytesSent <= previousOutbound.bytesSent
        && !['bandwidth', 'cpu'].includes(outbound.qualityLimitationReason))) {
        return unknown();
      }
      previousOutbound = { id: outbound.id, timestamp: outbound.timestamp, bytesSent: outbound.bytesSent };
      const remote = stats.get(outbound.remoteId);
      const freshRemote = remote?.type === 'remote-inbound-rtp' && nonnegative(remote.timestamp)
        && (remote.id !== previousRemote?.id || remote.timestamp > previousRemote.timestamp);
      if (freshRemote) previousRemote = { id: remote.id, timestamp: remote.timestamp };
      const transport = stats.get(outbound.transportId);
      const pair = stats.get(transport?.selectedCandidatePairId);
      const capacity = pair?.type === 'candidate-pair' && nonnegative(pair.availableOutgoingBitrate) ? pair.availableOutgoingBitrate : undefined;
      const rtt = pair?.type === 'candidate-pair' && nonnegative(pair.currentRoundTripTime) ? pair.currentRoundTripTime
        : freshRemote && nonnegative(remote.roundTripTime) ? remote.roundTripTime : undefined;
      const loss = freshRemote && nonnegative(remote.fractionLost) ? remote.fractionLost : undefined;
      if (rtt !== undefined) baselineRtt = Math.min(baselineRtt, rtt);
      const delayed = rtt !== undefined && (rtt > 0.45 || (rtt > 0.25 && rtt > baselineRtt + 0.15));
      const limited = ['bandwidth', 'cpu'].includes(outbound.qualityLimitationReason);
      const congested = limited || delayed || loss >= 0.05 || capacity < VIDEO_QUALITY[level].maxBitrate * 0.75;
      // Missing feedback and a quiet desktop are not proof of spare bandwidth. Recovery is deliberately slower.
      const healthy = !congested && outbound.qualityLimitationReason === 'none'
        && (capacity !== undefined || (loss !== undefined && rtt !== undefined))
        && (loss === undefined || loss < 0.02) && (rtt === undefined || rtt < 0.25)
        && (capacity === undefined || capacity >= VIDEO_QUALITY[Math.min(level + 1, VIDEO_QUALITY.length - 1)].maxBitrate * 1.1);
      bad = congested ? bad + 1 : 0;
      good = healthy ? good + 1 : 0;
      if (bad >= 2 || good >= 8) {
        level = Math.max(0, Math.min(VIDEO_QUALITY.length - 1, level + (bad >= 2 ? -1 : 1)));
        bad = good = 0;
      }
      return current();
    },
  };
}

export function createJpegFrameFilter() {
  let previous;
  return {
    shouldSend(buffer) {
      const bytes = new Uint8Array(buffer);
      if (!bytes.length || bytes.length > 512 * 1024) return false;
      if (sameBytes(previous, bytes)) return false;
      // Retain only one bounded JPEG in this capture session, never pixels or a cross-session cache.
      previous = bytes;
      return true;
    },
    clear() { previous = undefined; },
  };
}
