import type { JournalOp } from './core.apply.journal.types';
import type { VersionedValue } from './core.persistenceCodec.types';

export type SplitJournalRecord = {
  txId: string;
  runtimeEpoch: number;
  epoch: number;
  status: 'pending' | 'committed';
  ops: Array<VersionedValue<JournalOp>>;
};

export type QueryInvalidationRecord = {
  recordVersion: 1;
  revision: number;
  identities: Record<string, number>;
};

export type StorageResetEntry = { key: string; value: string };

export type StorageResetIntent = {
  recordVersion: 1;
  restore: StorageResetEntry[];
};
