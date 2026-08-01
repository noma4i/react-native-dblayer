import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { DbDefaults } from '../../types';

/** Delegate one cache-key freshness decision to React Query's canonical query state machine. */
export const isQueryFresh = (client: QueryClient, queryKey: QueryKey, staleTime: number): boolean => {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  return query !== undefined && !query.isStaleByTime(staleTime);
};

/** THE freshness-vocabulary resolver: a numeric value passes through, a class name resolves via `defaults.freshnessClasses`, an unknown name throws. */
// DEVIATION: class names resolve on the first run, not at define time - handles are declared at
// module scope before configureDb provides defaults.freshnessClasses, so define-time lookup cannot exist.
export const resolveStaleTime = (value: number | string | undefined, defaults: DbDefaults): number | undefined => {
  if (typeof value !== 'string') return value;
  const resolved = defaults.freshnessClasses?.[value];
  if (resolved === undefined) throw new Error(`react-native-dblayer: unknown freshness class '${value}' - declare it in configureDb defaults.freshnessClasses`);
  return resolved;
};

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
export const persistenceWindowOf = (empty: boolean, staleTime: number | string | undefined, emptyStaleTime: number | string | undefined, defaults: DbDefaults): number | null => {
  const window = empty
    ? (resolveStaleTime(emptyStaleTime, defaults) ?? defaults.emptyStaleTime ?? resolveStaleTime(staleTime, defaults) ?? defaults.staleTime ?? 0)
    : (resolveStaleTime(staleTime, defaults) ?? defaults.staleTime ?? 0);
  return Number.isFinite(window) && window > 0 ? window : null;
};
