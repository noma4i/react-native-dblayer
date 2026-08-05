import { compositeKey } from '../core/serialize';
import type { ModelCore, ModelDefinitions, ModelDefinitionsOptions } from '../types';
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
  }) as ModelCore<TStored, TInput>['query']
});
