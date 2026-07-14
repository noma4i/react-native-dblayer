"use strict";

import { mmkvStoragePlane } from "../core/planes/storagePlane.js";
import { setDbLogger } from "../core/logger.js";
import { setDbTrackSink } from "../core/tracking.js";
import { setDbTransport } from "../core/transport.js";
import { createCommitBus } from "../core/apply/commitBus.js";
let runtimeConfig = null;
const commitBus = createCommitBus();

/** Single static namespace for every persisted key; the library has no account split. */
const STORAGE_PREFIX = 'dbl:';

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
export const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};
export const getStoragePrefix = () => STORAGE_PREFIX;
export const getCommitBus = () => commitBus;
//# sourceMappingURL=configure.js.map