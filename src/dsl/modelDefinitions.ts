import { buildScopeKey } from '../core/compileDbWhere';
import { getDbLogger } from '../core/logger';
import { compositeKey } from '../core/serialize';
import { createDbSubscriptionRuntime } from '../core/subscriptionRuntime';
import { getDbTransport } from '../core/transport';
import type { ModelCore, ModelDefinitions, ModelDefinitionsOptions, ModelFetchConfig } from '../types';
import { createModelStatusPoller } from '../utils/modelStatusPoller';
import { useEffect } from 'react';
import { defineDetachedOperation } from './defineDetachedOperation';
import { defineFetch } from './defineFetch';
import { defineModelIngest } from './defineIngest';
import { defineModelMutation } from './defineMutation';
import { defineQuery } from './defineQuery';

export const createModelDefinitions = <TStored extends { id: string; updatedAt?: string | null } & Record<string, unknown>, TInput>(
  options: ModelDefinitionsOptions<TStored, TInput>
): ModelDefinitions<TStored, TInput> => ({
  // The runtime branch adds `live` exactly when the overload's live config is present.
  query: ((name, queryConfig) => {
    const model = options.context.model<ModelCore<TStored, TInput>>();
    const { live, ...queryOptions } = queryConfig;
    const handle = defineQuery({
      ...queryOptions,
      key: queryConfig.key ?? compositeKey(options.modelId, name),
      into: queryConfig.into ?? (model as NonNullable<typeof queryConfig.into>)
    });
    if (!live) return handle;
    const compiled = defineModelIngest(model, live);
    let runtime: ReturnType<typeof createDbSubscriptionRuntime> | null = null;
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
      use: (scope: unknown, readOptions?: { enabled?: boolean }) => {
        const result = handle.use(scope as never, readOptions);
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
      live: { apply: compiled.apply }
    };
  }) as ModelCore<TStored, TInput>['query'],
  mutation: (name, mutationConfig) => {
    /** Mutation dedupe keys are idempotency identities, not scope bucket keys; scope validation belongs to scope handles and queries. */
    const dedupe = mutationConfig.dedupe === false ? false : (mutationConfig.dedupe ?? { key: input => compositeKey(options.modelId, name, buildScopeKey(input)) });
    return defineModelMutation(compositeKey(options.modelId, name), { ...mutationConfig, dedupe });
  },
  detached: (kind, detachedConfig) => defineDetachedOperation(options.context.model<ModelCore<TStored, TInput>>(), kind, detachedConfig),
  fetch: <TData, TFetchInput, TSelected>(name: string, fetchConfig: ModelFetchConfig<TData, TFetchInput, TSelected>) =>
    defineFetch<TData, TFetchInput, TSelected>({ ...fetchConfig, key: fetchConfig.key ?? compositeKey(options.modelId, name) } as Parameters<
      typeof defineFetch<TData, TFetchInput, TSelected>
    >[0]),
  poller: (name, pollerConfig) =>
    createModelStatusPoller({
      ...pollerConfig,
      fetch: async id => {
        try {
          return (await getDbTransport().query({ query: pollerConfig.document, variables: pollerConfig.vars?.(id) ?? { id } })).data;
        } catch (error) {
          getDbLogger().error('Model.poller', 'fetch failed', { key: compositeKey(options.modelId, name), id, error });
          throw error;
        }
      }
    }),
  ingest: entries => defineModelIngest(options.context.model<ModelCore<TStored, TInput>>(), entries)
});
