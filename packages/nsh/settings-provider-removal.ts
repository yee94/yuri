import { createSettingsLaneOwner, scopedSettingsPath, settingsObject, settingsRows, type SettingsRequest, type SettingsRequestLane } from './settings-protocol';

export type ProviderRemovalSnapshot = {
  present: boolean;
  integrationID: string;
  credentials: string[];
  environment: boolean;
  files: string[];
};
export type ProviderRemovalFailure = 'metadata' | 'environment' | 'unavailable' | 'failed' | 'stale';
export class ProviderRemovalError extends Error {
  constructor(readonly reason: ProviderRemovalFailure) { super(reason); }
}
export function providerRemovalBlock(snapshot: ProviderRemovalSnapshot): 'environment' | 'unavailable' | null {
  return snapshot.environment ? 'environment' : !snapshot.files.length && !snapshot.credentials.length ? 'unavailable' : null;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProviderRemovalError('metadata');
  return value;
}

/** SDK gap: official list responses are { data }, source metadata is the Host's direct map. */
export async function readProviderRemovalSnapshot(send: SettingsRequest, providerID: string, directory?: string, integrationHint?: string): Promise<ProviderRemovalSnapshot> {
  const location = directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : '';
  const [providerReply, integrationReply, sourceReply] = await Promise.all([
    send(`/api/provider${location}`), send(`/api/integration${location}`),
    send(scopedSettingsPath('/api/config/providers/sources', directory)),
  ]);
  const providers = settingsRows(settingsObject(providerReply).data);
  const integrations = settingsRows(settingsObject(integrationReply).data);
  if (providers.some(item => typeof item.id !== 'string' || !item.id) || integrations.some(item => typeof item.id !== 'string' || !item.id)) throw new ProviderRemovalError('metadata');
  const provider = providers.find(item => item.id === providerID);
  const integrationID = provider?.integrationID === undefined ? integrationHint || providerID : identifier(provider.integrationID);
  const integration = integrations.find(item => item.id === integrationID);
  const connections = integration ? settingsRows(integration.connections) : [];
  if (connections.some(item => !['env', 'credential'].includes(String(item.type)))) throw new ProviderRemovalError('metadata');
  const credentials = [...new Set(connections.filter(item => item.type === 'credential').map(item => identifier(item.id)))];
  const sources = settingsObject(sourceReply);
  const source = Object.hasOwn(sources, providerID) ? settingsObject(sources[providerID]) : undefined;
  // A provider with missing source metadata is unknown, never an empty/deletable source.
  if (provider && !source) throw new ProviderRemovalError('metadata');
  const files = source ? settingsRows(source.files).map(file => {
    if (!['user', 'project', 'custom'].includes(String(file.scope))) throw new ProviderRemovalError('metadata');
    return identifier(file.path);
  }) : [];
  return { present: !!provider, integrationID, credentials, environment: connections.some(item => item.type === 'env'), files };
}

/** One page/Host-scoped destructive intent. ACKed writes are not replayed after failed reads. */
export function createProviderRemoval(send: SettingsRequest, scope: { providerID: string; directory?: string; current: () => boolean }) {
  const transport = createSettingsLaneOwner(send, scope.current);
  let pending: object | null = null;
  let recovered = false;
  let plan: { consent: ProviderRemovalSnapshot; configDone: boolean; configAttempted: boolean; credentialsDone: Set<string>; credentialsAttempted: Set<string> } | undefined;
  async function inspect(lane = transport.capture()) {
    if (!lane?.current()) throw new ProviderRemovalError('stale');
    try { const result = await readProviderRemovalSnapshot(lane.request, scope.providerID, scope.directory, plan?.consent.integrationID); if (!lane.current()) throw new ProviderRemovalError('stale'); return result; }
    catch (error) { if (error instanceof ProviderRemovalError) throw error; throw new ProviderRemovalError('metadata'); }
  }
  async function remove(consent?: ProviderRemovalSnapshot): Promise<void> {
    if (pending) throw new ProviderRemovalError('failed');
    const lane = transport.capture();
    if (!lane?.current()) throw new ProviderRemovalError('stale');
    const scopedSend = lane.request, flight = {}; pending = flight;
    try {
      const fresh = await inspect(lane);
      if (!lane.current()) throw new ProviderRemovalError('stale');
      if (fresh.environment) throw new ProviderRemovalError('environment');
      const authorized = plan?.consent || consent;
      if (!authorized) throw new ProviderRemovalError('unavailable');
      // Re-read after the native confirmation, but never widen that consent to new accounts/files.
      if (fresh.integrationID !== authorized.integrationID || fresh.credentials.some(id => !authorized.credentials.includes(id))
        || (!plan?.configDone && fresh.files.some(path => !authorized.files.includes(path)))) throw new ProviderRemovalError('failed');
      if (!plan) {
        const block = providerRemovalBlock(fresh);
        if (block) throw new ProviderRemovalError(block);
        plan = { consent: { ...authorized, credentials: [...authorized.credentials], files: [...authorized.files] }, configDone: false, configAttempted: false, credentialsDone: new Set(), credentialsAttempted: new Set() };
      }
      if (plan.configAttempted && !fresh.files.length) plan.configDone = true;
      if (!plan.configDone) {
        if (recovered && plan.configAttempted) throw new ProviderRemovalError('failed');
        plan.configAttempted = true;
        const response = await scopedSend(scopedSettingsPath(`/api/provider/${encodeURIComponent(scope.providerID)}/auth?scope=config`, scope.directory), 'DELETE');
        if (!lane.current()) throw new ProviderRemovalError('stale');
        if (response && typeof response === 'object' && 'success' in response && response.success === false) plan.configAttempted = false;
        const result = settingsObject(response);
        if (result.success !== true || typeof result.removed !== 'boolean') { plan.configAttempted = false; throw new ProviderRemovalError('failed'); }
        plan.configDone = true;
      }
      for (const credentialID of plan.consent.credentials) {
        if (plan.credentialsDone.has(credentialID)) continue;
        // A lost DELETE reply is reconciled from scoped integration metadata, never a raw credential read.
        if (fresh.credentials.includes(credentialID)) {
          if (recovered && plan.credentialsAttempted.has(credentialID)) throw new ProviderRemovalError('failed');
          plan.credentialsAttempted.add(credentialID);
          const reply = await scopedSend(`/api/credential/${encodeURIComponent(credentialID)}`, 'DELETE');
          if (!lane.current()) throw new ProviderRemovalError('stale');
          if (reply !== undefined && reply !== null) settingsObject(reply);
        }
        plan.credentialsDone.add(credentialID);
      }
      const confirmed = await inspect(lane);
      if (!lane.current()) throw new ProviderRemovalError('stale');
      if (confirmed.present || confirmed.files.length || confirmed.credentials.length || confirmed.environment) throw new ProviderRemovalError('failed');
    } catch (error) {
      if (!lane.current()) throw new ProviderRemovalError('stale');
      if (error instanceof ProviderRemovalError) throw error;
      throw new ProviderRemovalError('failed');
    } finally { if (pending === flight) pending = null; }
  }
  return { inspect, remove, started: () => !!plan, replaceLane(next: SettingsRequestLane | null) { transport.replaceLane(next); recovered = true; pending = null; } };
}
