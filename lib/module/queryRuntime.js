"use strict";

import { focusManager as TanStackFocusManager, QueryClient as TanStackQueryClient, QueryClientProvider as TanStackQueryClientProvider, useQuery as TanStackUseQuery, useQueryClient as TanStackUseQueryClient } from '@tanstack/react-query';

/** Package-owned shared React Query focus manager for the host app runtime. */
export const focusManager = TanStackFocusManager;

/** Package-owned shared React Query client constructor for the host app runtime. */
export const QueryClient = TanStackQueryClient;

/** Package-owned shared React Query provider for the host app runtime. */
export const QueryClientProvider = TanStackQueryClientProvider;

/** Package-owned shared React Query hook for the host app runtime. */
export const useQuery = TanStackUseQuery;

/** Package-owned shared React Query client hook for the host app runtime. */
export const useQueryClient = TanStackUseQueryClient;

/** Package-owned shared React Query client instance type; DBLay rows are not Query cache entries. */
//# sourceMappingURL=queryRuntime.js.map