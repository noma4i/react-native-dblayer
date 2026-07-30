import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { DbDefaults } from '../../types';
/** Delegate one cache-key freshness decision to React Query's canonical query state machine. */
export declare const isQueryFresh: (client: QueryClient, queryKey: QueryKey, staleTime: number) => boolean;
/** THE freshness-vocabulary resolver: a numeric value passes through, a class name resolves via `defaults.freshnessClasses`, an unknown name throws. */
export declare const resolveStaleTime: (value: number | string | undefined, defaults: DbDefaults) => number | undefined;
//# sourceMappingURL=queryFreshness.d.ts.map