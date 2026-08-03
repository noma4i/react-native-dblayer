import type { FacadeRuntimeModel, GraphqlActionDefinition, ModelActionMethods, RowOperation } from '../types';
/**
 * A declared action becomes its runtime handle here. The declared mode decides which action lifecycle
 * carries it - a durable operation, a poller, or a request - and the caller sees one handle either
 * way, so a consumer never reproduces the lifecycle of the mode it happened to get.
 */
export declare const createOperation: <TStored extends {
    id: string;
    updatedAt?: string | null;
}, TInput>(runtime: FacadeRuntimeModel<TStored, TInput>, id: string | null | undefined) => RowOperation<TStored>;
export declare const createAction: <TStored extends {
    id: string;
    updatedAt?: string | null;
}, TInput, TDefinition extends GraphqlActionDefinition<any, any, any, any, any>>(runtime: FacadeRuntimeModel<TStored, TInput>, name: string, definition: TDefinition) => ModelActionMethods<Record<"defined", TDefinition>>["defined"];
//# sourceMappingURL=facadeActions.d.ts.map