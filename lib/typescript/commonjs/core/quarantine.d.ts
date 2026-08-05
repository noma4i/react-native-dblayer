import type { QuarantineEntry } from '../types/core.quarantine.types';
/** Keep one rejected payload with its reason instead of dropping it. */
export declare const putQuarantine: (entry: QuarantineEntry) => void;
/** Every quarantined payload, oldest first. */
export declare const readQuarantineEntries: () => QuarantineEntry[];
/** Remove and return the entries the predicate accepts - the only automatic removal path (fsck restore). */
export declare const takeQuarantineEntries: (accepts: (entry: QuarantineEntry) => boolean) => QuarantineEntry[];
//# sourceMappingURL=quarantine.d.ts.map