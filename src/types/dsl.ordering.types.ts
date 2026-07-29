type IsAny<T> = 0 extends 1 & T ? true : false;

/** Scalar values that field-based ordering can compare as a total order. */
export type OrderableValue = string | number | boolean | null | undefined;

/** Stored fields whose complete value domain is supported by field-based ordering. */
export type OrderableField<TStored> = Extract<
  IsAny<TStored> extends true
    ? string
    : string extends keyof TStored
      ? string
      : {
          [K in keyof TStored]-?: IsAny<TStored[K]> extends true ? never : TStored[K] extends OrderableValue ? K : never;
        }[keyof TStored],
  string
>;

/** One declared field-order key. */
export type ReadOrder<TStored> = { field: OrderableField<TStored>; direction: 'asc' | 'desc' };

/** Field-based scope order over one orderable stored field. */
export type FieldSort<TStored> =
  IsAny<TStored> extends true
    ? { field: string; dir: 'asc' | 'desc' }
    : string extends keyof TStored
      ? { field: string; dir: 'asc' | 'desc' }
      : {
          [K in keyof TStored]-?: IsAny<TStored[K]> extends true
            ? never
            : TStored[K] extends OrderableValue
              ? { field: Extract<K, string>; dir: 'asc' | 'desc' }
              : never;
        }[keyof TStored];

/** Consumer comparator plus the stored fields that can change its result. */
export type ComparatorSort<TStored> = {
  comparator: { call(a: TStored, b: TStored): number }['call'];
  orderFields?: ReadonlyArray<keyof TStored & string>;
};

/** Declared multi-key field order: keys compare left to right, each with its own direction, missing values last per key, implicit id tie-break. */
export type MultiFieldSort<TStored> = ReadonlyArray<FieldSort<TStored>>;

/** Client-side scope ordering, excluding server-owned order. */
export type ClientSort<TStored> = FieldSort<TStored> | MultiFieldSort<TStored> | ComparatorSort<TStored>;
