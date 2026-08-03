import { getDbLogger } from '../core/logger';
import { compositeKey } from '../core/serialize';
import { getDbTransport } from '../core/transport';
import type { ModelCore, ModelDefinitions, ModelDefinitionsOptions } from '../types';
import { createModelStatusPoller } from '../utils/modelStatusPoller';
import { defineQuery } from './defineQuery';

export const createModelDefinitions = <TStored extends { id: string; updatedAt?: string | null } & Record<string, unknown>, TInput>(
  options: ModelDefinitionsOptions<TStored, TInput>
): ModelDefinitions<TStored, TInput> => ({
  query: ((name, queryConfig) => {
    const model = options.context.model<ModelCore<TStored, TInput>>();
    return defineQuery({
      ...queryConfig,
      key: queryConfig.key ?? compositeKey(options.modelId, name),
      into: queryConfig.into ?? (model as NonNullable<typeof queryConfig.into>)
    });
  }) as ModelCore<TStored, TInput>['query'],
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
    })
});
