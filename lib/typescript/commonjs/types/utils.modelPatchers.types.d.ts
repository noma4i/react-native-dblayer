import type { RowId } from './utils.singletonStatics.types';
export type NestedObjectPatcher<_TRow extends RowId, _TField extends string, TArgs extends unknown[]> = (id: string, ...args: TArgs) => boolean;
export type KeyedArrayPatcher<TSub extends object, _TKey extends Extract<keyof TSub, string>> = {
    /** Replace an existing sub-row with the same key, then append the normalized sub-row. */
    upsert(rows: TSub[] | null | undefined, input: unknown): TSub[];
    /** Remove sub-rows whose key equals the supplied value. */
    remove(rows: TSub[] | null | undefined, keyValue: string): TSub[];
};
export type IdArrayPatcher = {
    /** Replace an existing id, then insert it at the requested edge. */
    upsert(ids: string[] | null | undefined, id: string, position: 'prepend' | 'append'): string[];
    /** Remove an id. */
    remove(ids: string[] | null | undefined, id: string): string[];
};
//# sourceMappingURL=utils.modelPatchers.types.d.ts.map