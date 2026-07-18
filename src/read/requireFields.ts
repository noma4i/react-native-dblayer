/**
 * Returns whether every requested stored field is present on a row.
 * `undefined` is missing; `null` is a present stored value.
 */
export const hasRequiredFields = <TRow extends object>(row: TRow | null | undefined, fields: readonly string[]): row is TRow =>
  row != null && fields.every(field => row[field as keyof TRow] !== undefined);
