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

/** Set the GraphQL transport used by query and mutation runtimes. */
export const setDbTransport = transport => {
  currentDbTransport.set(transport);
};

/** Get the currently configured GraphQL transport. */
export const getDbTransport = () => currentDbTransport.get();
//# sourceMappingURL=transport.js.map