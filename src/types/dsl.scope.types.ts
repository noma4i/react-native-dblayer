export interface ScopeSpec<TStored> {
  by?: Record<string, keyof TStored & string>;
  member?: (row: TStored) => boolean;
  sort?:
    | { field: keyof TStored & string; dir: 'asc' | 'desc' }
    | {
        comparator: (a: TStored, b: TStored) => number;
        orderFields?: ReadonlyArray<keyof TStored & string>;
      }
    | 'server-order';
  retention?: { maxRows: number };
}
