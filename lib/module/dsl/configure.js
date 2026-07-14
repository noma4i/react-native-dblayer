"use strict";

import { mmkvStoragePlane } from "../core/planes/storagePlane.js";
import { setDbLogger } from "../core/logger.js";
import { setDbTrackSink } from "../core/tracking.js";
import { setDbTransport } from "../core/transport.js";
import { createCommitBus } from "../core/apply/commitBus.js";
import { createApplyRuntime } from "../core/apply/transaction.js";
import { createOperationState } from "../core/planes/operationState.js";
let runtimeConfig = null;
let applyRuntime = null;
let operationState = null;
const commitBus = createCommitBus();

/** Single flat key namespace for everything the library persists. */
const STORAGE_PREFIX = 'dbl:';

/** Configure v6 runtime seams and defaults. */
export const configureDb = options => {
  runtimeConfig = {
    ...options,
    storage: options.storage ?? mmkvStoragePlane()
  };
  applyRuntime = null;
  operationState = null;
  setDbTransport(options.transport);
  if (options.logger) setDbLogger(options.logger);
  if (options.track) setDbTrackSink(options.track);
};
export const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

/** App-owned TanStack QueryClient handed to configureDb; undefined until configured. */
export const getDbQueryClient = () => runtimeConfig?.queryClient;
export const getStoragePrefix = () => STORAGE_PREFIX;
export const getCommitBus = () => commitBus;

/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 */
export const getApplyRuntime = () => {
  if (!applyRuntime) {
    const {
      storage
    } = getDbRuntimeConfig();
    applyRuntime = createApplyRuntime({
      storage,
      prefix: getStoragePrefix,
      bus: commitBus
    });
  }
  return applyRuntime;
};

/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
export const getOperationState = () => {
  if (!operationState) {
    const {
      storage
    } = getDbRuntimeConfig();
    operationState = createOperationState({
      storage,
      prefix: getStoragePrefix,
      now: () => Date.now()
    });
    operationState.hydrate();
  }
  return operationState;
};
//# sourceMappingURL=configure.js.map