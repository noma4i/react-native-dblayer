import type { QueryKey } from '@tanstack/react-query';
import type { IncrementalCommitBatch } from '../../types';
import { getCommitBus, getDbQueryClient, isDbConfigured } from '../../dsl/configure';
import { registerReset } from '../reset';
import { compositeKey } from '../serialize';

type ActiveFetchReader = {
  queryKey: QueryKey;
  /** Drop the reader's freshness when it is a foreground-resume candidate. */
  markResumeStale(): boolean;
  /** Refetch after the coordinator selected this reader's resume chunk. */
  refetch(): Promise<void>;
};

const readers = new Set<ActiveFetchReader>();
registerReset(() => readers.clear());
const serializedKeyOf = (queryKey: QueryKey): string => JSON.stringify(queryKey);

/**
 * Committed-row loss feed: when every row identity behind a query's applied result is destroyed,
 * the query's freshness is dropped (its meta is invalidated in the package QueryClient) and any
 * active reader of that key refetches. Chain meta stores composite row ids for exactly this check.
 */
const noteLostRows = (batch: IncrementalCommitBatch): void => {
  if (!isDbConfigured()) return;
  const lost = new Set(batch.rows.filter(row => row.kind === 'destroy').map(row => compositeKey(row.model, row.id)));
  if (lost.size === 0) return;
  const client = getDbQueryClient();
  const emptiedKeys: QueryKey[] = [];
  for (const query of client.getQueryCache().getAll()) {
    const meta = query.state.data as { ids?: string[] } | undefined;
    if (!meta?.ids || meta.ids.length === 0) continue;
    const remaining = meta.ids.filter(id => !lost.has(id));
    if (remaining.length === meta.ids.length) continue;
    // Keep the original freshness stamp: shrinking the survivor set must never make a query fresher.
    client.setQueryData(query.queryKey, { ...meta, ids: remaining }, { updatedAt: query.state.dataUpdatedAt });
    if (remaining.length === 0) {
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: 'none' });
      emptiedKeys.push(query.queryKey);
    }
  }
  if (batch.mode === 'maintenance' || emptiedKeys.length === 0) return;
  const emptied = new Set(emptiedKeys.map(serializedKeyOf));
  for (const reader of readers) {
    if (emptied.has(serializedKeyOf(reader.queryKey))) void reader.refetch().catch(() => {});
  }
};

getCommitBus().subscribeAll(noteLostRows);

/** Register one live query/fetch reader for loss-driven refetch and foreground resume; returns the release callback. */
export const registerActiveFetchReaders = (reader: ActiveFetchReader): (() => void) => {
  readers.add(reader);
  return () => readers.delete(reader);
};

/** Refetch every active reader of one query key: invalidation stays lazy for keys nobody is reading. */
export const refetchActiveFetchReaders = (queryKey: QueryKey): void => {
  const target = serializedKeyOf(queryKey);
  for (const reader of readers) {
    if (serializedKeyOf(reader.queryKey) === target) void reader.refetch().catch(() => {});
  }
};

/** Resume every active reader whose freshness lapsed, in provider-owned chunks. */
export const resumeFetchLedgers = async (chunkSize: number, isCurrent: () => boolean): Promise<number> => {
  const refetches = [...readers].filter(reader => reader.markResumeStale());
  let refetched = 0;
  for (let index = 0; index < refetches.length; index += chunkSize) {
    if (!isCurrent()) return refetched;
    const chunk = refetches.slice(index, index + chunkSize);
    refetched += chunk.length;
    await Promise.all(chunk.map(reader => Promise.resolve().then(reader.refetch).catch(() => {})));
  }
  return refetched;
};
