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
