import type { QueryKey } from '@tanstack/react-query';
import type { QueryPersistenceDeclaration, QueryPersistenceRecord } from '../../types';
import { getDbQueryClient } from '../../dsl/configure';
import { readPersistedQuery, removePersistedQuery, writePersistedQuery } from '../queryPersistence';

/**
 * Move one bucket between storage and the query cache.
 *
 * Both reader surfaces land and store buckets the same way, and the parts that must agree are the
 * quiet ones: a record outside its window is discarded rather than shown, the stored timestamp
 * decides freshness instead of the moment of restore, and an invalidation that landed while the app
 * was closed is replayed. A second copy of this is how one surface starts trusting a record the
 * other would have thrown away.
 */
export const restorePersistedBucket = <TPayload, TCached, TScope>(args: {
  declaration: QueryPersistenceDeclaration;
  identity: string;
  queryKey: QueryKey;
  /** Rejects a record that does not belong to this identity; throwing drops and reports it. */
  validate: (record: QueryPersistenceRecord) => { payload: TPayload; scope: TScope };
  /** The shape the reader caches; the stored record decides the window, not this value. */
  cache: (payload: TPayload) => TCached;
  window: (empty: boolean) => number | null;
}): TCached | undefined => {
  const record = readPersistedQuery<TPayload, TScope>(args.declaration, args.identity, args.validate);
  if (record === undefined) return undefined;
  if (args.window(record.empty) === null) {
    removePersistedQuery(args.declaration, args.identity);
    return undefined;
  }
  const cached = args.cache(record.payload);
  const client = getDbQueryClient();
  client.setQueryData(args.queryKey, cached, { updatedAt: record.dataUpdatedAt });
  if (record.invalidated) void client.invalidateQueries({ queryKey: args.queryKey, exact: true, refetchType: 'none' });
  return cached;
};

/**
 * Store one landed bucket, or drop the stored one when this payload may not outlive the session.
 *
 * @see restorePersistedBucket for why both surfaces share this.
 */
export const persistBucket = <TPayload, TScope>(args: {
  declaration: QueryPersistenceDeclaration;
  identity: string;
  queryKey: QueryKey;
  scope: TScope;
  payload: TPayload;
  empty: boolean;
  window: (empty: boolean) => number | null;
  invalidationRevision?: number;
}): void => {
  if (args.window(args.empty) === null) {
    removePersistedQuery(args.declaration, args.identity);
    return;
  }
  writePersistedQuery({
    ...args.declaration,
    identity: args.identity,
    scope: args.scope,
    payload: args.payload,
    empty: args.empty,
    dataUpdatedAt: getDbQueryClient().getQueryState(args.queryKey)!.dataUpdatedAt,
    invalidationRevision: args.invalidationRevision
  });
};
