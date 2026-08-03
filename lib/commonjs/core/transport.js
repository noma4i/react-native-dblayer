"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbTransport = exports.responseDataOrThrow = exports.getDbTransport = void 0;
var _configuredSlot = require("./configuredSlot.js");
const notConfigured = () => {
  throw new Error('react-native-dblayer: transport not configured - call setDbTransport(...) at app start');
};
const defaultDbTransport = {
  query: notConfigured,
  mutation: notConfigured
};
const currentDbTransport = (0, _configuredSlot.createConfiguredSlot)(defaultDbTransport);

/**
 * Set the GraphQL transport used by remote relation and action runtimes. Normally set once via
 * `configureDb({ transport })`; call directly only to swap the transport after initial configuration
 * (e.g. re-authenticating with a new client instance).
 *
 * @param transport `{ query, mutation }` implementation to install.
 */
const setDbTransport = transport => {
  currentDbTransport.set(transport);
};

/**
 * Get the currently configured GraphQL transport.
 *
 * @returns The transport passed to `configureDb`/`setDbTransport`; throws if none has been configured yet.
 */
exports.setDbTransport = setDbTransport;
const getDbTransport = () => currentDbTransport.get();

/** Reject resolved GraphQL responses with errors before any caller can apply their partial data. */
exports.getDbTransport = getDbTransport;
const responseDataOrThrow = response => {
  if (!response.errors || response.errors.length === 0) return response.data;
  const error = new Error(response.errors.map(item => item.message).join('; '));
  error.cause = response.errors;
  throw error;
};
exports.responseDataOrThrow = responseDataOrThrow;
//# sourceMappingURL=transport.js.map