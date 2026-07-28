import type { IncrementalCommitBatch } from '../../types';
import { getCommitBus } from '../../dsl/configure';
import { compositeKey } from '../serialize';

type RegisteredLedger = {
  noteRowsLost(ids: readonly string[]): void;
  refetchStaleReaders(): Promise<void>;
  activeRefetches(): Array<{ markResumeStale(): boolean; refetch(): Promise<void> }>;
};

const ledgers = new Set<RegisteredLedger>();
const onlineListeners = new Set<() => void>();
let online = true;

const noteLostRows = (batch: IncrementalCommitBatch): void => {
  const ids = batch.rows.filter(row => row.kind === 'destroy').map(row => compositeKey(row.model, row.id));
  if (ids.length === 0) return;
  for (const ledger of ledgers) ledger.noteRowsLost(ids);
  if (batch.mode !== 'maintenance') {
    for (const ledger of ledgers) void ledger.refetchStaleReaders();
  }
};

getCommitBus().subscribeAll(noteLostRows);

/**
 * Register a query-owned ledger for loss notifications and foreground resume.
 *
 * This registry deliberately omits the runtime-generation barrier documented on `registerApplyTarget`.
 * That barrier exists to stop a second registration from silently replacing an entry held under a
 * stable name. Here membership is keyed by ledger instance in a `Set`, so re-adding the same instance
 * is a no-op and two instances coexist - the silent-overwrite class the barrier defends against cannot
 * occur. Every caller also registers exactly once from a module-level `defineQuery` or `defineFetch`
 * body and discards the returned disposer, so no same-generation duplicate is reachable at all.
 */
export const registerFetchLedger = (ledger: RegisteredLedger): (() => void) => {
  ledgers.add(ledger);
  return () => ledgers.delete(ledger);
};

/** Read the coordinator-owned connectivity state used by every fetch ledger. */
export const isFetchNetworkOnline = (): boolean => online;

/** Test and host adapter for coordinator connectivity changes. */
export const setFetchNetworkOnline = (nextOnline: boolean): void => {
  if (online === nextOnline) return;
  online = nextOnline;
  for (const listener of onlineListeners) listener();
};

/** Subscribe to coordinator connectivity changes. */
export const subscribeFetchNetwork = (listener: () => void): (() => void) => {
  onlineListeners.add(listener);
  return () => onlineListeners.delete(listener);
};

/** Resume every registered query ledger with the provider-owned chunk size. */
export const resumeFetchLedgers = async (chunkSize: number, isCurrent: () => boolean): Promise<number> => {
  const refetches = [...ledgers].flatMap(ledger => ledger.activeRefetches()).filter(reader => reader.markResumeStale());
  let refetched = 0;
  for (let index = 0; index < refetches.length; index += chunkSize) {
    if (!isCurrent()) return refetched;
    const chunk = refetches.slice(index, index + chunkSize);
    refetched += chunk.length;
    await Promise.all(chunk.map(reader => Promise.resolve().then(reader.refetch).catch(() => {})));
  }
  return refetched;
};
