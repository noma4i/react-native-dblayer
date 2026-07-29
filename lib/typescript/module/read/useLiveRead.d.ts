import type { Dependency } from '../types';
/** Shallow row equality across both key sets; array values compare element identity one level deep. */
export declare const rowsShallowEqual: (left: object, right: object) => boolean;
/**
 * Reactive read primitive with pinpoint emissions: the hook subscribes to the commit bus with an
 * explicit dependency set, recomputes only when a commit batch intersects it, and re-renders only
 * when the computed value actually changed (per `isEqual`), keeping stable references otherwise.
 * Render-phase recompute happens only when the dependency signature changes; compute output must be
 * a pure function of committed DB state plus dependency-encoded inputs. Constant hook topology -
 * always the same hooks in the same order.
 */
export declare const useLiveRead: <T>(compute: () => T, deps: ReadonlyArray<Dependency>, isEqual?: (a: T, b: T) => boolean) => T;
//# sourceMappingURL=useLiveRead.d.ts.map