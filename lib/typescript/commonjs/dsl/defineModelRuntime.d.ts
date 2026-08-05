import type { InferBuildInput, InferStoredFields, ModelFieldSpecs, ModelLandingOptions, ModelConfig, ModelCore, QueryScopeReads, RequiredReadUse, ScopeHandle } from '../types';
/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, write policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `update`/`destroy`/`insert`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
export declare const defineModelRuntime: <const TFields extends ModelFieldSpecs, TScopeNames extends string = never, TExt extends Record<string, unknown> = {}, TQueryScopeNames extends string = never>(config: ModelConfig<TFields, TScopeNames, TExt, TQueryScopeNames>, landing?: ModelLandingOptions) => Omit<ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>, "use" | "scopes"> & {
    use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | "id"> & QueryScopeReads<InferStoredFields<TFields>, TQueryScopeNames>;
    scopes: { [K in TScopeNames]: ScopeHandle<InferStoredFields<TFields>, Record<string, unknown>, InferBuildInput<TFields>>; };
} & TExt;
//# sourceMappingURL=defineModelRuntime.d.ts.map