import type { DbWhere } from '../types';
export declare const matchesDbWhere: <TStored>(row: TStored, where: DbWhere<TStored> | undefined) => boolean;
export declare const normalizeDbCondition: <TStored>(condition?: Partial<TStored>) => Partial<TStored> | undefined;
/** Sentinel scope key shared by every fetch-state read/write for an empty or missing filter. */
export declare const ROOT_SCOPE_KEY = "__root__";
/**
 * Derive the stable scope key for a filter/scope value.
 *
 * Single standard shared by every fetch-state read/write path (hook-level `useBaseQuery`/
 * `useBaseInfiniteQuery` and model-level `defineModel`) so the same filter always maps to
 * the same key regardless of which path wrote or reads it - previously each path serialized filters
 * slightly differently (raw truthy-check vs `undefined`-stripping normalization), which could split a
 * single logical scope across two different stored keys.
 *
 * `null`/`undefined` and a plain object that normalizes to nothing (empty, or every value is
 * `undefined`) collapse to `ROOT_SCOPE_KEY`. Any other non-record input (string, number, boolean,
 * array) serializes to its own distinct key so primitive scopes never collide.
 */
export declare const buildScopeKey: (input: unknown) => string;
//# sourceMappingURL=compileDbWhere.d.ts.map