import { create } from 'zustand';
import { persist, type PersistStorage, type StateStorage, type StorageValue } from 'zustand/middleware';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { DesktopSettings } from '@/lib/desktop';
import {
  instanceScopedStorageKey,
  mayReadLegacyUnscopedInstanceStorage,
} from '@/lib/instanceScopedStorage';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  getRuntimeKey,
  getRuntimeTransportIdentity,
  isRuntimeInstanceChange,
  subscribeRuntimeEndpointChanged,
} from '@/lib/runtime-switch';
import { runtimeScopedStorageKey } from '@/lib/runtimeScopedStorage';
import { getSafeStorage } from '@/stores/utils/safeStorage';

// The default name selects the approved SVG wordmark in the sidebar.
export const DEFAULT_SIDEBAR_BRAND_NAME = 'Yuri';

const STORE_NAME = 'sidebar-brand-store';

interface SidebarBrandStore {
  sidebarBrandName: string;
  setSidebarBrandName: (name: string) => void;
  synchronizeFromSettings: (settings: Pick<DesktopSettings, 'sidebarBrandName'>) => void;
}

let suppressPersistWrite = false;
let localWriteSeq = 0;
let pendingLocalEdit: { runtimeKey: string; value: string; seq: number } | null = null;
const backfilledBrands = new Set<string>();

const createSidebarBrandStorage = <S>(): PersistStorage<S> | undefined => {
  let storage: StateStorage;
  try {
    storage = getSafeStorage();
  } catch {
    return undefined;
  }

  const parse = (value: string | null): StorageValue<S> | null => {
    if (value === null) return null;
    return JSON.parse(value) as StorageValue<S>;
  };

  const resolveRaw = (name: string): string | null | Promise<string | null> => {
    const runtimeKey = getRuntimeKey();
    const instanceKey = instanceScopedStorageKey(name, runtimeKey);
    const transportKey = runtimeScopedStorageKey(name, getRuntimeTransportIdentity());

    const readFallback = (): string | null | Promise<string | null> => {
      const legacyTransport = storage.getItem(transportKey);
      const adoptLegacyTransport = (value: string | null): string | null | Promise<string | null> => {
        if (value !== null) {
          // Promote legacy transport-scoped brand into the stable instance bucket
          // so subsequent SSH port or direct<->relay changes preserve it.
          try {
            storage.setItem(instanceKey, value);
          } catch {
            // Best-effort migration; read still succeeds from the legacy key.
          }
          return value;
        }
        if (!mayReadLegacyUnscopedInstanceStorage(runtimeKey)) return null;
        return storage.getItem(name);
      };
      return legacyTransport instanceof Promise
        ? legacyTransport.then(adoptLegacyTransport)
        : adoptLegacyTransport(legacyTransport);
    };

    const primary = storage.getItem(instanceKey);
    if (primary instanceof Promise) {
      return primary.then((value) => (value !== null ? value : readFallback()));
    }
    if (primary !== null) return primary;
    return readFallback();
  };

  return {
    getItem: (name) => {
      const raw = resolveRaw(name);
      return raw instanceof Promise ? raw.then(parse) : parse(raw);
    },
    setItem: (name, value) => {
      if (suppressPersistWrite) return;
      const scopedName = instanceScopedStorageKey(name, getRuntimeKey());
      storage.setItem(scopedName, JSON.stringify(value));
    },
    removeItem: (name) => {
      const scopedName = instanceScopedStorageKey(name, getRuntimeKey());
      storage.removeItem(scopedName);
    },
  };
};

export const useSidebarBrandStore = create<SidebarBrandStore>()(
  persist(
    (set, get) => ({
      sidebarBrandName: DEFAULT_SIDEBAR_BRAND_NAME,
      setSidebarBrandName: (name) => {
        const nextName = name.slice(0, 64);
        const changed = get().sidebarBrandName !== nextName;
        if (changed) {
          set({ sidebarBrandName: nextName });
        }
        if (getRegisteredRuntimeAPIs()?.runtime.isVSCode) return;
        const seq = ++localWriteSeq;
        const runtimeKey = getRuntimeKey();
        pendingLocalEdit = { runtimeKey, value: nextName, seq };
        void updateDesktopSettings({ sidebarBrandName: nextName }).finally(() => {
          if (pendingLocalEdit?.seq === seq) {
            pendingLocalEdit = null;
          }
        });
      },
      synchronizeFromSettings: (settings) => {
        if (getRegisteredRuntimeAPIs()?.runtime.isVSCode) return;
        const runtimeKey = getRuntimeKey();
        if (typeof settings.sidebarBrandName === 'string') {
          const incoming = settings.sidebarBrandName.slice(0, 64);
          if (
            pendingLocalEdit
            && pendingLocalEdit.runtimeKey === runtimeKey
            && pendingLocalEdit.value !== incoming
          ) {
            return;
          }
          set((state) => (state.sidebarBrandName === incoming ? state : { sidebarBrandName: incoming }));
          return;
        }

        // Server omitted sidebarBrandName (unset or older remote server):
        // keep any locally persisted instance brand and backfill once.
        if (pendingLocalEdit && pendingLocalEdit.runtimeKey === runtimeKey) return;
        const currentName = get().sidebarBrandName;
        const backfillId = `${runtimeKey}:${currentName}`;
        if (backfilledBrands.has(backfillId)) return;
        const stored = useSidebarBrandStore.persist.getOptions().storage?.getItem(STORE_NAME);
        const maybeBackfill = (entry: unknown) => {
          if (!entry || getRuntimeKey() !== runtimeKey) return;
          if (pendingLocalEdit && pendingLocalEdit.runtimeKey === runtimeKey) return;
          if (backfilledBrands.has(backfillId)) return;
          backfilledBrands.add(backfillId);
          void updateDesktopSettings({ sidebarBrandName: currentName });
        };
        if (stored instanceof Promise) {
          void stored.then(maybeBackfill);
        } else {
          maybeBackfill(stored);
        }
      },
    }),
    {
      // Instance-scoped (stable host/runtimeKey) so SSH local port churn and
      // direct<->relay switches preserve the host's brand, while packaged
      // multi-window (shared yuri-ui:// origin) remains isolated per host.
      name: STORE_NAME,
      storage: createSidebarBrandStorage(),
      version: 3,
      migrate: (persistedState, version) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState;
        }

        const state = { ...persistedState } as Partial<SidebarBrandStore>;
        if (version < 1 && state.sidebarBrandName === 'YEE CODE') {
          state.sidebarBrandName = DEFAULT_SIDEBAR_BRAND_NAME;
        }
        // Title-case default → uppercase mark (empty stays empty: hide logo).
        if (version < 2 && state.sidebarBrandName === 'Open Chamber') {
          state.sidebarBrandName = DEFAULT_SIDEBAR_BRAND_NAME;
        }
        // Migrate only historical defaults; custom names and hidden slots survive.
        if (version < 3 && (state.sidebarBrandName === 'OPEN CHAMBER' || state.sidebarBrandName === 'Open Chamber')) {
          state.sidebarBrandName = DEFAULT_SIDEBAR_BRAND_NAME;
        }
        return state;
      },
    },
  ),
);

const resetInMemoryBrandToDefault = (): void => {
  suppressPersistWrite = true;
  try {
    useSidebarBrandStore.setState({ sidebarBrandName: DEFAULT_SIDEBAR_BRAND_NAME });
  } finally {
    suppressPersistWrite = false;
  }
};

// Synchronize with host settings and rehydrate cleanly on instance switches.
if (typeof window !== 'undefined') {
  window.addEventListener('yuri:settings-synced', (event: Event) => {
    const settings = (event as CustomEvent<DesktopSettings>).detail;
    if (settings) {
      useSidebarBrandStore.getState().synchronizeFromSettings(settings);
    }
  });

  subscribeRuntimeEndpointChanged((detail) => {
    if (!isRuntimeInstanceChange(detail)) return;
    pendingLocalEdit = null;
    const targetRuntimeKey = detail.runtimeKey;
    const stored = useSidebarBrandStore.persist.getOptions().storage?.getItem(STORE_NAME);
    const apply = (entry: unknown) => {
      if (getRuntimeKey() !== targetRuntimeKey) return;
      if (entry) {
        void useSidebarBrandStore.persist.rehydrate();
      } else {
        resetInMemoryBrandToDefault();
      }
    };
    if (stored instanceof Promise) {
      void stored.then(apply);
    } else {
      apply(stored);
    }
  });
}
