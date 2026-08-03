import type { ModelRootOwner, ModelRootPlan, OperationIntent, WriteOp } from '../types';
export declare const modelRootIntentOf: (root: unknown) => OperationIntent;
export declare const compileModelRootPlan: <TContext, TInput, TStored extends {
    id: string;
}>(owner: ModelRootOwner<TInput>, root: ModelRootPlan<TContext, TInput, TStored>, context: TContext) => WriteOp[];
//# sourceMappingURL=modelRootPlan.d.ts.map