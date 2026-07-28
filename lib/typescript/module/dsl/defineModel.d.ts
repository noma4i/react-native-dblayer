import type { InferBuildInput, InferStoredFields, ModelFieldSpecs, ModelConfig, ModelCore, QueryScopeReads, QueryScopeSpec, RequiredReadUse, ScopeHandle, ScopeSpec, ScopeValueOf } from '../types';
/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/write policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `update`/`destroy`/`insert`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
export declare const defineModel: <const TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<InferStoredFields<TFields>>> = {}, TExt extends Record<string, unknown> = {}, TQueryScopes extends Record<string, QueryScopeSpec<InferStoredFields<TFields>>> = {}>(config: ModelConfig<TFields, TScopes, TExt, TQueryScopes>) => Omit<ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>, "use" | "scopes"> & {
    use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | "id"> & QueryScopeReads<InferStoredFields<TFields>, TQueryScopes>;
    scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildInput<TFields>>; };
} & TExt;
//# sourceMappingURL=defineModel.d.ts.map