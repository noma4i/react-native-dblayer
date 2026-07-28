"use strict";

import { buildScopeKey } from "../core/compileDbWhere.js";
import { getDbLogger } from "../core/logger.js";
import { compositeKey } from "../core/serialize.js";
import { createDbSubscriptionRuntime } from "../core/subscriptionRuntime.js";
import { getDbTransport } from "../core/transport.js";
import { createModelStatusPoller } from "../utils/modelStatusPoller.js";
import { useEffect } from 'react';
import { defineDetachedOperation } from "./defineDetachedOperation.js";
import { defineFetch } from "./defineFetch.js";
import { defineModelIngest } from "./defineIngest.js";
import { defineMutation } from "./defineMutation.js";
import { defineQuery } from "./defineQuery.js";
import { defineView } from "./defineView.js";
export const createModelDefinitions = options => ({
  // The runtime branch adds `live` exactly when the overload's live config is present.
  query: (name, queryConfig) => {
    const model = options.context.model();
    const {
      live,
      ...queryOptions
    } = queryConfig;
    const handle = defineQuery({
      ...queryOptions,
      key: queryConfig.key ?? compositeKey(options.modelId, name),
      into: queryConfig.into ?? model
    });
    if (!live) return handle;
    const compiled = defineModelIngest(model, live);
    let runtime = null;
    let readers = 0;
    const sync = () => {
      if (readers === 0) return;
      runtime ??= createDbSubscriptionRuntime(compiled.entries);
      runtime.setActive(true);
    };
    model.registerReset(() => {
      // stop(), not setActive(false): the replaced runtime is discarded forever, so its own reset
      // registration must be released too - otherwise every reset leaks one dead registry entry.
      runtime?.stop();
      runtime = null;
      sync();
    });
    return {
      ...handle,
      use: (scope, readOptions) => {
        const result = handle.use(scope, readOptions);
        useEffect(() => {
          readers += 1;
          sync();
          return () => {
            readers -= 1;
            if (readers === 0) runtime?.setActive(false);
          };
        }, []);
        return result;
      },
      live: {
        apply: compiled.apply
      }
    };
  },
  mutation: (name, mutationConfig) => {
    /** Mutation dedupe keys are idempotency identities, not scope bucket keys; scope validation belongs to scope handles and queries. */
    const dedupe = mutationConfig.dedupe === false ? false : mutationConfig.dedupe ?? {
      key: input => compositeKey(options.modelId, name, buildScopeKey(input))
    };
    return defineMutation({
      ...mutationConfig,
      dedupe
    });
  },
  detached: (kind, detachedConfig) => defineDetachedOperation(options.context.model(), kind, detachedConfig),
  fetch: (name, fetchConfig) => defineFetch({
    ...fetchConfig,
    key: fetchConfig.key ?? compositeKey(options.modelId, name)
  }),
  view: (name, viewConfig) => defineView(options.context.model(), name, viewConfig),
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
  }),
  ingest: entries => defineModelIngest(options.context.model(), entries)
});
//# sourceMappingURL=modelDefinitions.js.map