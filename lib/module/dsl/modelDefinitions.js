"use strict";

import { compositeKey } from "../core/serialize.js";
import { defineQuery } from "./defineQuery.js";
export const createModelDefinitions = options => ({
  query: (name, queryConfig) => {
    const model = options.context.model();
    return defineQuery({
      ...queryConfig,
      key: queryConfig.key ?? compositeKey(options.modelId, name),
      into: queryConfig.into ?? model
    });
  }
});
//# sourceMappingURL=modelDefinitions.js.map