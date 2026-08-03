"use strict";

import { createConfiguredSlot } from "./configuredSlot.js";
const notConfigured = () => {
  throw new Error('react-native-dblayer: transport not configured - call setDbTransport(...) at app start');
};
const defaultDbTransport = {
  query: notConfigured,
  mutation: notConfigured
};
const currentDbTransport = createConfiguredSlot(defaultDbTransport);

/**
 * Set the GraphQL transport used by remote relation and action runtimes. Normally set once via
 * `configureDb({ transport })`; call directly only to swap the transport after initial configuration
 * (e.g. re-authenticating with a new client instance).
 *
 * @param transport `{ query, mutation }` implementation to install.
 */
export const setDbTransport = transport => {
  currentDbTransport.set(transport);
};

/**
 * Get the currently configured GraphQL transport.
 *
 * @returns The transport passed to `configureDb`/`setDbTransport`; throws if none has been configured yet.
 */
export const getDbTransport = () => currentDbTransport.get();

/** Reject resolved GraphQL responses with errors before any caller can apply their partial data. */
export const responseDataOrThrow = response => {
  if (!response.errors || response.errors.length === 0) return response.data;
  const error = new Error(response.errors.map(item => item.message).join('; '));
  error.cause = response.errors;
  throw error;
};
//# sourceMappingURL=transport.js.map