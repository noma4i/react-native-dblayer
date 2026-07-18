/**
 * Returns whether every requested stored field is present on a row.
 * `undefined` is missing; `null` is a present stored value.
 */
export declare const hasRequiredFields: <TRow extends object>(row: TRow | null | undefined, fields: readonly string[]) => row is TRow;
//# sourceMappingURL=requireFields.d.ts.map