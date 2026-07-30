import type {
  ModelBuildInput,
  ModelFacade,
  ModelFacadeConfig,
  ModelStoredValue,
  AnyFields,
  DbShape,
  GraphqlActionDefinition,
  ModelConfig,
  RelationDecl,
  RelationSpec
} from '../types';
import { defineModelFacade } from './defineModelFacade';
import { defineModelRuntime } from './defineModelRuntime';

/**
 * Define one class-like persistent model.
 *
 * @param key Stable model identity used by storage, dependencies, and diagnostics.
 * @param config Schema, associations, named relations, actions, sideloads, policies, and statics.
 * @returns A model singleton with local reads/writes, flat relations, and model-owned actions.
 */
export function defineModel<
  const TKey extends string,
  TShape extends DbShape<any, AnyFields>,
  const TRelations extends Record<string, RelationSpec<ModelStoredValue<TShape>, any>>,
  const TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>,
  const TEvents extends Record<string, { type: 'live' }>,
  const TAssociations extends Record<string, RelationDecl<unknown>>,
  TStatics extends Record<string, unknown>
>(
  key: TKey,
  config: ModelFacadeConfig<TShape, TRelations, TActions, TEvents, TAssociations, TStatics>
): ModelFacade<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TEvents, TAssociations, TStatics>;
export function defineModel<
  const TFields extends import('../types').ModelFieldSpecs,
  TScopeNames extends string = never,
  TExt extends Record<string, unknown> = {},
  TQueryScopeNames extends string = never
>(
  config: ModelConfig<TFields, TScopeNames, TExt, TQueryScopeNames>
): ReturnType<typeof defineModelRuntime<TFields, TScopeNames, TExt, TQueryScopeNames>>;
export function defineModel(first: string | ModelConfig<any, any, any, any>, second?: ModelFacadeConfig<any, any, any, any, any, any>): unknown {
  return typeof first === 'string' ? defineModelFacade(first, second!) : defineModelRuntime(first);
}
