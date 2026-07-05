/** Cast unknown connection nodes at the package boundary. */
export const castNodes = <T>(nodes: unknown[]): T[] => nodes as T[];
/** Cast an unknown node at the package boundary. */
export const castNode = <T>(node: unknown): T => node as T;
/** Cast an unknown value for TanStack DB query predicates. */
export const toQueryValue = (value: unknown): string | number | boolean | bigint | Date | null | undefined | Array<unknown> =>
  value as string | number | boolean | bigint | Date | null | undefined | Array<unknown>;
