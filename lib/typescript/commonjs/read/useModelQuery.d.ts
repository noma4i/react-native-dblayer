import type { ModelQuerySpec, RowRecord } from '../types';
/**
 * Read a declared model query through the collection engine. The reader holds the live query while
 * it is mounted and gives it back when it leaves, so a screen that walks through filters leaves no
 * queries behind it. A held query belongs to one runtime generation: `resetRuntime` wakes every
 * mounted reader through the commit bus, and the reader re-acquires its query from the new runtime,
 * so the first post-reset value already comes from the new generation without a remount.
 *
 * @param modelId Owning model.
 * @param key Stable identity of the declaration: same key, same live query.
 * @param spec Declared filter, order, limit and required fields.
 * @param select Projection from the query rows to the value the reader renders.
 * @param isEqual Equality that decides whether a change reaches React.
 * @returns Selected value, recomputed only when the query rows actually changed.
 */
export declare const useModelQuery: <TValue>(modelId: string, key: string, spec: ModelQuerySpec<RowRecord>, select: (rows: RowRecord[]) => TValue, isEqual?: (left: TValue, right: TValue) => boolean) => TValue;
//# sourceMappingURL=useModelQuery.d.ts.map