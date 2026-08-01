import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { DbDefaults } from '../../types';
/** Delegate one cache-key freshness decision to React Query's canonical query state machine. */
export declare const isQueryFresh: (client: QueryClient, queryKey: QueryKey, staleTime: number) => boolean;
/** THE freshness-vocabulary resolver: a numeric value passes through, a class name resolves via `defaults.freshnessClasses`, an unknown name throws. */
export declare const resolveStaleTime: (value: number | string | undefined, defaults: DbDefaults) => number | undefined;
/**
 * The window a durable record is worth keeping for. A result is persisted only while its declared
 * freshness still means something: a window of zero or an infinite one both say the record answers
 * nothing a fresh read would not, so no record is written.
 *
 * An empty result falls back to the non-empty window when no empty-specific one is declared, so a
 * surface that never declares `emptyStaleTime` keeps behaving as before.
 *
 * @param empty Whether the result carries no rows.
 * @param staleTime Declared freshness of the surface.
 * @param emptyStaleTime Declared freshness for empty results, when the surface distinguishes them.
 * @param defaults Package-wide freshness defaults.
 * @returns Window in milliseconds, or `null` when the result must not be persisted.
 */
export declare const persistenceWindowOf: (empty: boolean, staleTime: number | string | undefined, emptyStaleTime: number | string | undefined, defaults: DbDefaults) => number | null;
//# sourceMappingURL=queryFreshness.d.ts.map