/** Cast unknown connection nodes at the package boundary. */
export const castNodes = <T>(nodes: unknown[]): T[] => nodes as T[];
/** Cast an unknown node at the package boundary. */
export const castNode = <T>(node: unknown): T => node as T;
