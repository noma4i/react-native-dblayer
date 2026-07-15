import type { QueryClient } from '@tanstack/react-query';
import { configureDb } from '../../dsl/configure';
import type { DbLogger, DbTransport } from '../../types';
import { createMemoryStorage, type MemoryStorage } from './memoryStorage';

type ScenarioOptions = {
  storage?: MemoryStorage;
  transport?: Partial<DbTransport>;
  queryClient?: QueryClient;
  logger?: DbLogger;
  persistence?: { checkpointDelayMs?: number; maxPendingPlans?: number };
};

/** Configures one isolated contract scenario; models, scopes, queries, ingests, and mutations share its storage plane. */
export const createContractScenario = (options: ScenarioOptions = {}): MemoryStorage => {
  const plane = options.storage ?? createMemoryStorage();
  configureDb({
    storage: plane.storage,
    transport: {
      query: async <TData>() => ({ data: {} as TData }),
      mutation: async <TData>() => ({ data: {} as TData }),
      ...options.transport
    },
    queryClient: options.queryClient,
    logger: options.logger,
    defaults: options.persistence ? { persistence: options.persistence } : undefined
  });
  return plane;
};
