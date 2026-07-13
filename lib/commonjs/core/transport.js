"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbTransport = exports.getDbTransport = void 0;
var _configuredSlot = require("./configuredSlot.js");
const notConfigured = () => {
  throw new Error('react-native-dblayer: transport not configured - call setDbTransport(...) at app start');
};
const defaultDbTransport = {
  query: notConfigured,
  mutation: notConfigured
};
const currentDbTransport = (0, _configuredSlot.createConfiguredSlot)(defaultDbTransport);

/** Set the GraphQL transport used by query and mutation runtimes. */
const setDbTransport = transport => {
  currentDbTransport.set(transport);
};

/** Get the currently configured GraphQL transport. */
exports.setDbTransport = setDbTransport;
const getDbTransport = () => currentDbTransport.get();
exports.getDbTransport = getDbTransport;
//# sourceMappingURL=transport.js.map