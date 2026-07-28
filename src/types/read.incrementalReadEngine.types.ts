import type { IncrementalCommitBatch , Dependency } from './core.apply.commitBus.types';
import type { RowRecord } from './db.types';

/** One incremental read engine cell: cached value, change version, and per-batch delta application. */
export type Engine<T> = {
  signature: string;
  generation: number;
  value: T;
  version: number;
  apply(batch: IncrementalCommitBatch | null): boolean;
};

/** Factory input for a hook-cached engine: identity signature, builder, and invalidating deps. */
export type EngineInput<T> = {
  signature: string;
  create(): Engine<T>;
  deps: ReadonlyArray<Dependency>;
};

/** Harness input for `useIncrementalRead`: engine wiring plus batch application and selection. */
export type ReadEngineHarnessInput<T, TResult> = EngineInput<T> & {
  apply(engine: Engine<T>, batch: IncrementalCommitBatch | null): boolean;
  select(engine: Engine<T>): TResult;
  notifyEveryBatch?: boolean;
};

/** Options for the model row engine: predicate, ordering, snapshot access, and value selection. */
export type RowEngineOptions<T extends RowRecord, TValue> = {
  signature: string;
  model: string;
  where(row: T): boolean;
  options?: { orderBy?: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>; limit?: number };
  initial(): T[];
  read(id: string): T | undefined;
  select(rows: T[], count: number): TValue;
  isEqual?: (left: TValue, right: TValue) => boolean;
  countOnly?: boolean;
};
