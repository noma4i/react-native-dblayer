"use strict";

/** Delegate one cache-key freshness decision to React Query's canonical query state machine. */
export const isQueryFresh = (client, queryKey, staleTime) => {
  const query = client.getQueryCache().find({
    queryKey,
    exact: true
  });
  return query !== undefined && !query.isStaleByTime(staleTime);
};
//# sourceMappingURL=queryFreshness.js.map