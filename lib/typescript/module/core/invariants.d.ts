import type { IncomingRecord, ShouldAcceptIncomingOptions } from '../types';
/** Return true when an incoming timestamp is newer or equal to the existing timestamp. */
export declare const isIncomingNewer: (existingUpdatedAt: string | null | undefined, incomingUpdatedAt: string | null | undefined) => boolean;
/** Compare two plain records by shallow key/value equality. */
export declare const shallowEqual: <T extends Record<string, unknown>>(a: T, b: T) => boolean;
/** Return true when an incoming row should overwrite an existing row. */
export declare const shouldAcceptIncoming: <TExisting extends IncomingRecord, TIncoming extends IncomingRecord>(existing: TExisting, incoming: TIncoming, options?: ShouldAcceptIncomingOptions<TExisting, TIncoming>) => boolean;
//# sourceMappingURL=invariants.d.ts.map