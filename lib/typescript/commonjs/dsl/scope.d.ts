export type ScopeKind = 'membership' | 'entity';
export type Coverage = 'complete' | 'page' | 'delta';
export interface ScopeSpec<TStored> {
    by?: Record<string, keyof TStored & string>;
    kind?: ScopeKind;
    sort?: {
        field: keyof TStored & string;
        dir: 'asc' | 'desc';
    } | {
        comparator: (a: TStored, b: TStored) => number;
    } | 'server-order';
    retention?: {
        maxRows?: number;
    };
    renderKeys?: ReadonlyArray<keyof TStored>;
}
/** Declare a model scope without changing its specification. */
export declare const scope: <TStored>(spec: ScopeSpec<TStored>) => ScopeSpec<TStored>;
//# sourceMappingURL=scope.d.ts.map