import type { ModelBuildInput, ModelFacade, ModelFacadeConfig, ModelStoredValue, AnyFields, DbShape, GraphqlActionDefinition, GraphqlLiveDefinition, RelationDecl, RelationSpec } from '../types';
/**
 * Define one class-like persistent model.
 *
 * @param key Stable model identity used by storage, dependencies, and diagnostics.
 * @param config Schema, associations, named relations, actions, sideloads, policies, and statics.
 * @returns A model singleton with local reads/writes, flat relations, and model-owned actions.
 */
export declare const defineModel: <const TKey extends string, TShape extends DbShape<any, AnyFields>, const TRelations extends Record<string, RelationSpec<ModelStoredValue<TShape>, any>> = Record<never, never>, const TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>> = Record<never, never>, const TEvents extends Record<string, GraphqlLiveDefinition<any, any, any, any, any>> = Record<never, never>, const TAssociations extends Record<string, RelationDecl<unknown>> = Record<never, never>, TStatics extends Record<string, unknown> = Record<never, never>>(key: TKey, config: ModelFacadeConfig<TShape, TRelations, TActions, TEvents, TAssociations, TStatics, TKey>) => ModelFacade<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TEvents, TAssociations, TStatics, TKey>;
//# sourceMappingURL=defineModel.d.ts.map