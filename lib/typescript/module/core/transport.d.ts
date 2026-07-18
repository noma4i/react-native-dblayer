import type { DbTransport } from '../types';
export type { DbTransport };
/**
 * Set the GraphQL transport used by `defineQuery`/`defineMutation` runtimes. Normally set once via
 * `configureDb({ transport })`; call directly only to swap the transport after initial configuration
 * (e.g. re-authenticating with a new client instance).
 *
 * @param transport `{ query, mutation }` implementation to install.
 */
export declare const setDbTransport: (transport: DbTransport) => void;
/**
 * Get the currently configured GraphQL transport.
 *
 * @returns The transport passed to `configureDb`/`setDbTransport`; throws if none has been configured yet.
 */
export declare const getDbTransport: () => DbTransport;
//# sourceMappingURL=transport.d.ts.map