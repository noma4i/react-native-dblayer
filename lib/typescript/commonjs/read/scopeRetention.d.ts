type RetainedScopeSnapshot<T> = {
    rows: T[];
    totalCount: number;
};
export type KeepPreviousOption = {
    /** Retain the prior non-empty scope key until the current key produces its first resolved snapshot. Defaults to false. */
    keepPrevious?: boolean;
};
/** Retain one hook's last non-empty scope snapshot only while a new key remains unresolved. */
export declare const useScopeRetention: <T, TSnapshot extends RetainedScopeSnapshot<T>>(scopeKey: string | null, snapshot: TSnapshot, resolved: boolean, keepPrevious: boolean) => {
    snapshot: TSnapshot;
    isPreviousData: boolean;
};
export {};
//# sourceMappingURL=scopeRetention.d.ts.map