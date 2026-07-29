"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isQueryFresh = void 0;
/** Delegate one cache-key freshness decision to React Query's canonical query state machine. */
const isQueryFresh = (client, queryKey, staleTime) => {
  const query = client.getQueryCache().find({
    queryKey,
    exact: true
  });
  return query !== undefined && !query.isStaleByTime(staleTime);
};
exports.isQueryFresh = isQueryFresh;
//# sourceMappingURL=queryFreshness.js.map