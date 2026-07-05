"use strict";

const notConfigured = () => {
  throw new Error('react-native-dblayer: transport not configured - call setDbTransport(...) at app start');
};
const defaultDbTransport = {
  query: notConfigured,
  mutation: notConfigured
};
let currentDbTransport = defaultDbTransport;

/** Set the GraphQL transport used by query and mutation runtimes. */
export const setDbTransport = transport => {
  currentDbTransport = transport;
};

/** Get the currently configured GraphQL transport. */
export const getDbTransport = () => currentDbTransport;
//# sourceMappingURL=transport.js.map