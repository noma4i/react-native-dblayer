export type DecodedJournalRecord = {
  recordVersion: 2;
  txId: string;
  runtimeEpoch: number;
  epoch: number;
  ops: unknown;
  operationTransitions: unknown;
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
