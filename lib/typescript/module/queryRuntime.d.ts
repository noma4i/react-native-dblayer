import { focusManager as TanStackFocusManager, QueryClient as TanStackQueryClient, QueryClientProvider as TanStackQueryClientProvider, useQuery as TanStackUseQuery, useQueryClient as TanStackUseQueryClient } from '@tanstack/react-query';
/** Package-owned shared React Query focus manager for the host app runtime. */
export declare const focusManager: typeof TanStackFocusManager;
/** Package-owned shared React Query client constructor for the host app runtime. */
export declare const QueryClient: typeof TanStackQueryClient;
/** Package-owned shared React Query provider for the host app runtime. */
export declare const QueryClientProvider: typeof TanStackQueryClientProvider;
/** Package-owned shared React Query hook for the host app runtime. */
export declare const useQuery: typeof TanStackUseQuery;
/** Package-owned shared React Query client hook for the host app runtime. */
export declare const useQueryClient: typeof TanStackUseQueryClient;
/** Package-owned shared React Query client instance type; DBLay rows are not Query cache entries. */
export type QueryClient = InstanceType<typeof TanStackQueryClient>;
//# sourceMappingURL=queryRuntime.d.ts.map