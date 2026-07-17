"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useQueryClient = exports.useQuery = exports.focusManager = exports.QueryClientProvider = exports.QueryClient = void 0;
var _reactQuery = require("@tanstack/react-query");
/** Package-owned shared React Query focus manager for the host app runtime. */
const focusManager = exports.focusManager = _reactQuery.focusManager;

/** Package-owned shared React Query client constructor for the host app runtime. */
const QueryClient = exports.QueryClient = _reactQuery.QueryClient;

/** Package-owned shared React Query provider for the host app runtime. */
const QueryClientProvider = exports.QueryClientProvider = _reactQuery.QueryClientProvider;

/** Package-owned shared React Query hook for the host app runtime. */
const useQuery = exports.useQuery = _reactQuery.useQuery;

/** Package-owned shared React Query client hook for the host app runtime. */
const useQueryClient = exports.useQueryClient = _reactQuery.useQueryClient;

/** Package-owned shared React Query client instance type; DBLay rows are not Query cache entries. */
//# sourceMappingURL=queryRuntime.js.map