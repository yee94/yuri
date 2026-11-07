import type { SettingsRequest } from './settings-protocol';

/** A captured immutable operation, never a proxy resolving today's sender. The
 * native factories additionally verify stable Host/origin/authorization. */
export type SetupTourLane = Readonly<{ send: SettingsRequest; current: () => boolean }>;
