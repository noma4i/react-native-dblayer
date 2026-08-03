import type { DbShape, AnyFields, FacadeRuntimeModel, ModelBuildInput, ModelStoredValue, QueryHandle, RelationSpec, ScopeQueryHandle } from '../types';
/**
 * The remote half of a declared relation becomes a query handle here. Each declaration kind knows
 * how to read its own payload - one row, a complete list, or a cursor page - so the consumer never
 * assembles nodes, maps cursors, or patches membership after a fetch.
 */
export declare const compileRemoteRelations: <TShape extends DbShape<any, AnyFields>>(runtime: FacadeRuntimeModel<ModelStoredValue<TShape>, ModelBuildInput<TShape>>, relations: Record<string, RelationSpec<ModelStoredValue<TShape>, any>>) => Record<string, ScopeQueryHandle<ModelStoredValue<TShape>, Record<string, unknown>> | QueryHandle<ModelStoredValue<TShape>, Record<string, unknown>, ModelStoredValue<TShape> | undefined> | undefined>;
//# sourceMappingURL=facadeRemoteQueries.d.ts.map