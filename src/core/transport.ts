import type { DbTransport, DbTransportError } from '../types';
import { createConfiguredSlot } from './configuredSlot';

export type { DbTransport };

const notConfigured = (): never => {
  throw new Error('react-native-dblayer: transport not configured - call setDbTransport(...) at app start');
};

const defaultDbTransport: DbTransport = {
  query: notConfigured,
  mutation: notConfigured
};

const currentDbTransport = createConfiguredSlot(defaultDbTransport);

/**
 * Set the GraphQL transport used by `defineQuery`/`defineMutation` runtimes. Normally set once via
 * `configureDb({ transport })`; call directly only to swap the transport after initial configuration
 * (e.g. re-authenticating with a new client instance).
 *
 * @param transport `{ query, mutation }` implementation to install.
 */
export const setDbTransport = (transport: DbTransport): void => {
  currentDbTransport.set(transport);
};

/**
 * Get the currently configured GraphQL transport.
 *
 * @returns The transport passed to `configureDb`/`setDbTransport`; throws if none has been configured yet.
 */
export const getDbTransport = (): DbTransport => currentDbTransport.get();

/** Reject resolved GraphQL responses with errors before any caller can apply their partial data. */
export const responseDataOrThrow = <TData>(response: { data: TData; errors?: readonly DbTransportError[] }): TData => {
  if (!response.errors || response.errors.length === 0) return response.data;
  const error = new Error(response.errors.map(item => item.message).join('; '));
  (error as Error & { cause: readonly DbTransportError[] }).cause = response.errors;
  throw error;
};
