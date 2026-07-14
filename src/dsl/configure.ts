import type { QueryClient } from '@tanstack/react-query';
import type { DbLogger, DbTrackSink, DbTransport } from '../types';
import { mmkvStoragePlane, type StoragePlane } from '../core/planes/storagePlane';

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
let accountId = 'anon';

/** Configure v6 runtime seams and defaults. */
export const configureDb = (options: Omit<RuntimeConfig, 'storage'> & { storage?: StoragePlane }): void => {
  runtimeConfig = { ...options, storage: options.storage ?? mmkvStoragePlane() };
};

export const setAccountPartition = (nextAccountId: string | null): void => {
  accountId = nextAccountId ?? 'anon';
};

export const getDbRuntimeConfig = (): RuntimeConfig => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

export const getAccountPartitionPrefix = (): string => `dbl:${accountId}:`;
