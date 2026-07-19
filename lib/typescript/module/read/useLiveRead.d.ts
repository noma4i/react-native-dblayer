import type { Dependency } from '../core/apply/commitBus';
/** Shallow element-identity equality; rows keep stable refs in EntityState until replaced. */
export declare const arraysShallowEqual: <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) => boolean;
/** Shallow row equality across the union of both row key sets. */
export declare const rowsShallowEqual: (left: object, right: object) => boolean;
/**
 * Reactive read primitive with pinpoint emissions: the hook subscribes to the commit bus with an
 * explicit dependency set, recomputes only when a commit batch intersects it, and re-renders only
 * when the computed value actually changed (per `isEqual`), keeping stable references otherwise.
 * Constant hook topology - always the same hooks in the same order.
 */
export declare const useLiveRead: <T>(compute: () => T, deps: ReadonlyArray<Dependency>, isEqual?: (a: T, b: T) => boolean) => T;
//# sourceMappingURL=useLiveRead.d.ts.map