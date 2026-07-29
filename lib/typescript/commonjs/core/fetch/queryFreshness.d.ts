import type { QueryClient, QueryKey } from '@tanstack/react-query';
/** Delegate one cache-key freshness decision to React Query's canonical query state machine. */
export declare const isQueryFresh: (client: QueryClient, queryKey: QueryKey, staleTime: number) => boolean;
//# sourceMappingURL=queryFreshness.d.ts.map