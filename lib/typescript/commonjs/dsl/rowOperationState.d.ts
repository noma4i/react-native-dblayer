import type { RowOperationState } from '../types';
/** Read the complete operation state for one row from the durable ledger. */
export declare const readRowOperationState: <TStored>(model: string, id: string | null | undefined) => RowOperationState<TStored>;
/** Subscribe to the complete operation state for one row through one commit-bus dependency. */
export declare const useRowOperationState: <TStored>(model: string, id: string | null | undefined) => RowOperationState<TStored>;
//# sourceMappingURL=rowOperationState.d.ts.map