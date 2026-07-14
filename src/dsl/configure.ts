import type { QueryClient } from '@tanstack/react-query';
import type { DbLogger, DbTrackSink, DbTransport } from '../types';
import { mmkvStoragePlane, type StoragePlane } from '../core/planes/storagePlane';
import { setDbLogger } from '../core/logger';
import { setDbTrackSink } from '../core/tracking';
import { setDbTransport } from '../core/transport';
import { createCommitBus } from '../core/apply/commitBus';
import { createApplyRuntime, type ApplyRuntime } from '../core/apply/transaction';
import { createOperationState, type OperationState } from '../core/planes/operationState';

export interface DbDefaults {
  staleTime?: number;
  emptyStaleTime?: number;
  gcTime?: number;
  pageSize?: number;
  merge?: { dedupeWindowMs?: number };
  onSyncError?: (error: Error, ctx: { source: string; model?: string; scope?: unknown }) => void;
}

type RuntimeConfig = { transport: DbTransport; storage: StoragePlane; queryClient?: QueryClient; logger?: DbLogger; track?: DbTrackSink; defaults?: DbDefaults };
let runtimeConfig: RuntimeConfig | null = null;
let applyRuntime: ApplyRuntime | null = null;
let operationState: OperationState | null = null;
const commitBus = createCommitBus();

/** Single flat key namespace for everything the library persists. */
const STORAGE_PREFIX = 'dbl:';

/** Configure v6 runtime seams and defaults. */
export const configureDb = (options: Omit<RuntimeConfig, 'storage'> & { storage?: StoragePlane }): void => {
  runtimeConfig = { ...options, storage: options.storage ?? mmkvStoragePlane() };
  applyRuntime = null;
  operationState = null;
  setDbTransport(options.transport);
  if (options.logger) setDbLogger(options.logger);
  if (options.track) setDbTrackSink(options.track);
};

export const getDbRuntimeConfig = (): RuntimeConfig => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

/** App-owned TanStack QueryClient handed to configureDb; undefined until configured. */
export const getDbQueryClient = (): QueryClient | undefined => runtimeConfig?.queryClient;

export const getStoragePrefix = (): string => STORAGE_PREFIX;

export const getCommitBus = () => commitBus;

/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 */
export const getApplyRuntime = (): ApplyRuntime => {
  if (!applyRuntime) {
    const { storage } = getDbRuntimeConfig();
    applyRuntime = createApplyRuntime({ storage, prefix: getStoragePrefix, bus: commitBus });
  }
  return applyRuntime;
};

/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
export const getOperationState = (): OperationState => {
  if (!operationState) {
    const { storage } = getDbRuntimeConfig();
    operationState = createOperationState({ storage, prefix: getStoragePrefix, now: () => Date.now() });
    operationState.hydrate();
  }
  return operationState;
};
