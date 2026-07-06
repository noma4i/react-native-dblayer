"use strict";

import { setDbExtractSink, setDbMutationExtractResolver } from "./core/extract.js";
import { setDbLogger } from "./core/logger.js";
import { setDbModelDefaults } from "./core/modelDefaults.js";
import { setDbQueryClient } from "./core/queryClient.js";
import { setDbStorageAdapter } from "./core/storage.js";
import { setDbTransport } from "./core/transport.js";
/**
 * Configure package-wide transport, storage, logger, and extract seams.
 * @param options Runtime seams for the DB layer.
 * @returns void
 *
 * @example
 * configureDb({ transport, storage, logger });
 */
export const configureDb = options => {
  setDbTransport(options.transport);
  if (options.storage) setDbStorageAdapter(options.storage);
  if (options.logger) setDbLogger(options.logger);
  setDbQueryClient(options.queryClient);
  if (options.extract?.sink) setDbExtractSink(options.extract.sink);
  if (options.extract?.mutationResolver) setDbMutationExtractResolver(options.extract.mutationResolver);
  setDbModelDefaults(options.modelDefaults);
};
//# sourceMappingURL=configure.js.map