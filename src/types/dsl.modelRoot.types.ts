import type { WriteOp } from './core.apply.ops.types';

export type ModelRootUpdate<TStored extends { id: string }> = {
  id: string;
  patch: Partial<Omit<TStored, 'id'>>;
};

export type ModelRootPlan<TContext, TInput, TStored extends { id: string }> =
  | {
      insert: { select(context: TContext): TInput | readonly TInput[] | null };
      update?: never;
      destroy?: never;
    }
  | {
      insert?: never;
      update: { select(context: TContext): ModelRootUpdate<TStored> | readonly ModelRootUpdate<TStored>[] | null };
      destroy?: never;
    }
  | {
      insert?: never;
      update?: never;
      destroy: { select(context: TContext): string | readonly string[] | null };
    };

export type ModelRootOwner<TInput> = {
  readonly modelId: string;
  planRows(rows: readonly TInput[], options?: { origin?: 'event' }): WriteOp[];
  planEmpty?(): WriteOp[];
};
