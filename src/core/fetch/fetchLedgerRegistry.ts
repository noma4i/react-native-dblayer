import type { IncrementalCommitBatch } from '../apply/commitBus';
import { getCommitBus } from '../../dsl/configure';
import { compositeKey } from '../serialize';

type RegisteredLedger = {
  noteRowsLost(ids: readonly string[]): void;
  refetchStaleReaders(): Promise<void>;
  activeRefetches(): Array<() => Promise<void>>;
};

const ledgers = new Set<RegisteredLedger>();

const noteLostRows = (batch: IncrementalCommitBatch): void => {
  const ids = batch.rows.filter(row => row.kind === 'destroy').map(row => compositeKey(row.model, row.id));
  if (ids.length === 0) return;
  for (const ledger of ledgers) ledger.noteRowsLost(ids);
  if (batch.mode !== 'maintenance') {
    for (const ledger of ledgers) void ledger.refetchStaleReaders();
  }
};

getCommitBus().subscribeAll(noteLostRows);

/** Register a query-owned ledger for loss notifications and foreground resume. */
export const registerFetchLedger = (ledger: RegisteredLedger): (() => void) => {
  ledgers.add(ledger);
  return () => ledgers.delete(ledger);
};

/** Resume every registered query ledger with the provider-owned chunk size. */
export const resumeFetchLedgers = async (chunkSize: number, isCurrent: () => boolean): Promise<number> => {
  const refetches = [...ledgers].flatMap(ledger => ledger.activeRefetches());
  let refetched = 0;
  for (let index = 0; index < refetches.length; index += chunkSize) {
    if (!isCurrent()) return refetched;
    const chunk = refetches.slice(index, index + chunkSize);
    refetched += chunk.length;
    await Promise.all(chunk.map(refetch => Promise.resolve().then(refetch).catch(() => {})));
  }
  return refetched;
};
