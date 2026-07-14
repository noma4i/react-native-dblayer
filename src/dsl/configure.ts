import type { QueryClient } from '@tanstack/react-query';
import type { DbLogger, DbTrackSink, DbTransport } from '../types';
import { mmkvStoragePlane, type StoragePlane } from '../core/planes/storagePlane';
import { setDbLogger } from '../core/logger';
import { setDbTrackSink } from '../core/tracking';
import { setDbTransport } from '../core/transport';
import { createCommitBus } from '../core/apply/commitBus';

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
const commitBus = createCommitBus();

/** Single static namespace for every persisted key; the library has no account split. */
const STORAGE_PREFIX = 'dbl:';

/** Configure v6 runtime seams and defaults. */
export const configureDb = (options: Omit<RuntimeConfig, 'storage'> & { storage?: StoragePlane }): void => {
  runtimeConfig = { ...options, storage: options.storage ?? mmkvStoragePlane() };
  setDbTransport(options.transport);
  if (options.logger) setDbLogger(options.logger);
  if (options.track) setDbTrackSink(options.track);
};

export const getDbRuntimeConfig = (): RuntimeConfig => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

export const getStoragePrefix = (): string => STORAGE_PREFIX;

export const getCommitBus = () => commitBus;
