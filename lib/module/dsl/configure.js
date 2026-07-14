"use strict";

import { mmkvStoragePlane } from "../core/planes/storagePlane.js";
import { setDbLogger } from "../core/logger.js";
import { setDbTrackSink } from "../core/tracking.js";
import { setDbTransport } from "../core/transport.js";
let runtimeConfig = null;
let accountId = 'anon';

/** Configure v6 runtime seams and defaults. */
export const configureDb = options => {
  runtimeConfig = {
    ...options,
    storage: options.storage ?? mmkvStoragePlane()
  };
  setDbTransport(options.transport);
  if (options.logger) setDbLogger(options.logger);
  if (options.track) setDbTrackSink(options.track);
};
export const setAccountPartition = nextAccountId => {
  accountId = nextAccountId ?? 'anon';
};
export const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};
export const getAccountPartitionPrefix = () => `dbl:${accountId}:`;
//# sourceMappingURL=configure.js.map