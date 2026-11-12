import type { ProjectEntry } from '@/lib/api/types';

export type HostConnectionState = 'idle' | 'connecting' | 'connected' | 'degraded' | 'offline' | 'unauthorized' | 'incompatible';
export type HostPreparationPhase = 'connecting' | 'checking' | 'installing' | 'updating' | 'starting';

export interface RemoteHost {
  id: string;
  instanceId?: string;
  name: string;
  source: 'ssh' | 'relay' | 'direct';
  state: HostConnectionState;
  preparationPhase?: HostPreparationPhase;
  available?: boolean;
  /** Authorization/descriptor identity, independent of transient transport generation. */
  scopeGeneration?: string;
  /** Physical wire identity used only for live event admission. */
  generation?: string;
  lastConnectedAt?: number;
  lastSyncedAt?: number;
  lastError?: { code: string; message: string };
  version?: string;
  capabilities?: { remoteProjects: boolean };
}

export interface RemoteProject extends ProjectEntry {
  hostId: string;
  remoteProjectId: string;
  remoteState: 'ok' | 'remote-removed' | 'host-unavailable';
}

export interface HostCatalog {
  supported: boolean;
  hubId: string;
  reason?: string;
  hosts: RemoteHost[];
  projects: RemoteProject[];
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Remote Host response');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || Array.from(value).some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('Invalid Remote Host response field');
  }
  return value;
};
const timestamp = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const STATES: readonly unknown[] = ['idle', 'connecting', 'connected', 'degraded', 'offline', 'unauthorized', 'incompatible'];

/** Construct safe DTOs instead of retaining unknown credential-bearing response fields. */
export const parseRemoteHost = (input: unknown): RemoteHost => {
  const value = record(input);
  if (!STATES.includes(value.state) || !['ssh', 'relay', 'direct'].includes(String(value.source))) {
    throw new Error('Invalid Remote Host state/source');
  }
  const host: RemoteHost = {
    id: text(value.id), name: text(value.name),
    source: value.source as RemoteHost['source'], state: value.state as HostConnectionState,
  };
  if (typeof value.generation === 'string') host.generation = text(value.generation);
  if (host.state === 'connecting' && ['connecting', 'checking', 'installing', 'updating', 'starting'].includes(String(value.preparationPhase))) {
    host.preparationPhase = value.preparationPhase as HostPreparationPhase;
  }
  if (value.instanceId !== undefined) host.instanceId = text(value.instanceId);
  if (value.scopeGeneration !== undefined) host.scopeGeneration = text(value.scopeGeneration);
  if (typeof value.available === 'boolean') host.available = value.available;
  if (timestamp(value.lastConnectedAt) !== undefined) host.lastConnectedAt = timestamp(value.lastConnectedAt);
  if (timestamp(value.lastSyncedAt) !== undefined) host.lastSyncedAt = timestamp(value.lastSyncedAt);
  if (typeof value.version === 'string') host.version = text(value.version);
  if (value.lastError) {
    const error = record(value.lastError);
    host.lastError = { code: text(error.code), message: text(error.message) };
  }
  if (value.capabilities) host.capabilities = { remoteProjects: record(value.capabilities).remoteProjects === true };
  return host;
};

export const parseRemoteProject = (input: unknown): RemoteProject => {
  const value = record(input);
  if (!['ok', 'remote-removed', 'host-unavailable'].includes(String(value.remoteState))) {
    throw new Error('Invalid Remote Project state');
  }
  const project: RemoteProject = {
    id: text(value.id), path: text(value.path), hostId: text(value.hostId),
    remoteProjectId: text(value.remoteProjectId), remoteState: value.remoteState as RemoteProject['remoteState'],
  };
  if (value.instanceId !== undefined) project.instanceId = text(value.instanceId);
  for (const key of ['label', 'icon', 'iconBackground', 'color'] as const) {
    if (typeof value[key] === 'string') project[key] = value[key] as string;
    else if (key !== 'label' && value[key] === null) project[key] = null;
  }
  if (value.iconImage === null) project.iconImage = null;
  else if (value.iconImage) {
    const image = record(value.iconImage);
    const updatedAt = timestamp(image.updatedAt);
    if (updatedAt !== undefined && (image.source === 'custom' || image.source === 'auto')) {
      project.iconImage = { mime: text(image.mime), updatedAt, source: image.source };
    }
  }
  if (timestamp(value.addedAt) !== undefined) project.addedAt = timestamp(value.addedAt);
  if (timestamp(value.lastOpenedAt) !== undefined) project.lastOpenedAt = timestamp(value.lastOpenedAt);
  if (typeof value.sidebarCollapsed === 'boolean') project.sidebarCollapsed = value.sidebarCollapsed;
  return project;
};

export const parseHostCatalog = (input: unknown): HostCatalog => {
  const value = record(input);
  if (typeof value.supported !== 'boolean' || !Array.isArray(value.hosts) || !Array.isArray(value.projects)) {
    throw new Error('Invalid Remote Host catalog');
  }
  if (value.hosts.length > 1_000 || value.projects.length > 10_000) throw new Error('Remote Host catalog exceeds limits');
  const hubId = text(value.hubId);
  return {
    supported: value.supported, hubId,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    hosts: value.hosts.map(parseRemoteHost), projects: value.projects.map((project) => ({ ...parseRemoteProject(project), hubId })),
  };
};
