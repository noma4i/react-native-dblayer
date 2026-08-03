"use strict";

import { getDbLogger } from "../core/logger.js";
import { compositeKey } from "../core/serialize.js";
import { getDbTransport } from "../core/transport.js";
import { createModelStatusPoller } from "../utils/modelStatusPoller.js";
import { defineQuery } from "./defineQuery.js";
export const createModelDefinitions = options => ({
  query: (name, queryConfig) => {
    const model = options.context.model();
    return defineQuery({
      ...queryConfig,
      key: queryConfig.key ?? compositeKey(options.modelId, name),
      into: queryConfig.into ?? model
    });
  },
  poller: (name, pollerConfig) => createModelStatusPoller({
    ...pollerConfig,
    fetch: async id => {
      try {
        return (await getDbTransport().query({
          query: pollerConfig.document,
          variables: pollerConfig.vars?.(id) ?? {
            id
          }
        })).data;
      } catch (error) {
        getDbLogger().error('Model.poller', 'fetch failed', {
          key: compositeKey(options.modelId, name),
          id,
          error
        });
        throw error;
      }
    }
  })
});
//# sourceMappingURL=modelDefinitions.js.map