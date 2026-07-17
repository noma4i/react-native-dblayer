import {
  focusManager as TanStackFocusManager,
  QueryClient as TanStackQueryClient,
  QueryClientProvider as TanStackQueryClientProvider,
  useQuery as TanStackUseQuery,
  useQueryClient as TanStackUseQueryClient,
} from '@tanstack/react-query';

/** Package-owned shared React Query focus manager for the host app runtime. */
export const focusManager: typeof TanStackFocusManager = TanStackFocusManager;

/** Package-owned shared React Query client constructor for the host app runtime. */
export const QueryClient: typeof TanStackQueryClient = TanStackQueryClient;

/** Package-owned shared React Query provider for the host app runtime. */
export const QueryClientProvider: typeof TanStackQueryClientProvider = TanStackQueryClientProvider;

/** Package-owned shared React Query hook for the host app runtime. */
export const useQuery: typeof TanStackUseQuery = TanStackUseQuery;

/** Package-owned shared React Query client hook for the host app runtime. */
export const useQueryClient: typeof TanStackUseQueryClient = TanStackUseQueryClient;

/** Package-owned shared React Query client instance type; DBLay rows are not Query cache entries. */
export type QueryClient = InstanceType<typeof TanStackQueryClient>;
