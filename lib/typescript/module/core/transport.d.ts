import type { DbTransport, DbTransportError } from '../types';
/**
 * Set the GraphQL transport used by remote relation and action runtimes. Normally set once via
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
/** Reject resolved GraphQL responses with errors before any caller can apply their partial data. */
export declare const responseDataOrThrow: <TData>(response: {
    data: TData;
    errors?: readonly DbTransportError[];
}) => TData;
//# sourceMappingURL=transport.d.ts.map