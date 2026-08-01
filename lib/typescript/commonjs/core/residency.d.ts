import type { ResidencySnapshot } from '../types';
/**
 * Declare an internal collection whose entries must drain when their owner goes away. Counters
 * measure work that HAPPENED; a gauge measures what is still HELD, which is the only way a test can
 * tell a released entry from one that was never released - the two are otherwise indistinguishable,
 * and a leak looks exactly like correct behaviour until memory runs out.
 *
 * @param name Collection identity; several instances may share one name and their sizes are summed.
 * @param size Reads the instance's current entry count.
 * @returns Unregister function - call it when the instance itself is disposed.
 */
export declare const registerResidency: (name: string, size: () => number) => (() => void);
/** Current resident entry count of every registered collection, summed per name. */
export declare const residencySnapshot: () => ResidencySnapshot;
//# sourceMappingURL=residency.d.ts.map