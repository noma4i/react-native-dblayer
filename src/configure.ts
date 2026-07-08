import { setDbExtractSink, setDbMutationExtractResolver } from './core/extract';
import { DEFAULT_FETCH_STATE_MAX_AGE_MS, pruneStaleFetchStates } from './core/freshnessStorage';
import { setDbLogger } from './core/logger';
import { setDbModelDefaults } from './core/modelDefaults';
import { setDbQueryClient } from './core/queryClient';
import { setDbStorageAdapter } from './core/storage';
import { setDbTrackSink } from './core/tracking';
import { setDbTransport } from './core/transport';
import type { DbExtractSink, DbMutationExtractResolver } from './core/extract';
import type { DbLogger, DbModelDefaults, DbTrackSink, DbTransport, StorageAdapter } from './types';
import type { QueryClient } from '@tanstack/react-query';

export type ConfigureDbOptions = {
  /** GraphQL executor used by query and mutation runtimes. */
  transport: DbTransport;
  /**
   * Persistence backend for collections.
   * @default MMKV-backed adapter
   */
  storage?: StorageAdapter;
  /**
   * Logger for request and mutation runtime diagnostics.
   * @default no-op logger
   */
  logger?: DbLogger;
  /** Optional QueryClient used by imperative request invalidation/refetch/reset APIs. */
  queryClient?: QueryClient;
  /**
   * Optional analytics-agnostic sink for declarative mutation track events.
   * @default no-op
   */
  trackSink?: DbTrackSink;
  /** Optional side-load extract seam. */
  extract?: {
    /**
     * Applies resolved extract payloads to application collections.
     * @default no-op
     */
    sink?: DbExtractSink;
    /**
     * Resolves mutation extract specs with server results.
     * @default no-op
     */
    mutationResolver?: DbMutationExtractResolver;
  };
  /**
   * Defaults applied when a model does not specify its own option.
   * @default {}
   */
  modelDefaults?: DbModelDefaults;
};

/**
 * Configure package-wide transport, storage, logger, extract, and track seams.
 * @param options Runtime seams for the DB layer.
 * @returns void
 *
 * @example
 * configureDb({ transport, storage, logger });
 */
export const configureDb = (options: ConfigureDbOptions): void => {
  setDbTransport(options.transport);
  if (options.storage) setDbStorageAdapter(options.storage);
  if (options.logger) setDbLogger(options.logger);
  setDbQueryClient(options.queryClient);
  setDbTrackSink(options.trackSink);
  if (options.extract?.sink) setDbExtractSink(options.extract.sink);
  if (options.extract?.mutationResolver) setDbMutationExtractResolver(options.extract.mutationResolver);
  setDbModelDefaults(options.modelDefaults);
  pruneStaleFetchStates(DEFAULT_FETCH_STATE_MAX_AGE_MS);
};
