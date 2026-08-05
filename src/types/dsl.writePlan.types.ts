import type { WriteOp } from './core.apply.ops.types';

/** Registered model target accepted by a write plan. */
export type WriteTarget<TInput, TStored extends { id: string }> = {
  readonly key: string;
  build(input: TInput): TStored;
};

type AnyWriteTarget = { readonly key: string; build(input: never): { id: string } };
type WriteTargetInput<TTarget extends AnyWriteTarget> = Parameters<TTarget['build']>[0];
type WriteTargetStored<TTarget extends AnyWriteTarget> = ReturnType<TTarget['build']>;

/** Post-commit callback that can invalidate a consumer-owned read. */
export type InvalidationTarget = {
  invalidate(): void;
};

export type RuntimeWriteTarget = WriteTarget<unknown, { id: string }>;

export type WriteIntent =
  | { kind: 'upsert'; model: object; rows: unknown[] }
  | { kind: 'update'; model: object; id: unknown; patch: unknown }
  | { kind: 'destroy'; model: object; ids: unknown[] }
  | { kind: 'invalidate'; target: InvalidationTarget };

export type WritePlanCollectorOptions<TOwnerKey extends string = never> = {
  ownerKey?: TOwnerKey;
  origin?: Extract<WriteOp, { kind: 'upsert' }>['origin'];
};

export type CompiledWritePlan = {
  writeOps: WriteOp[];
  invalidations: InvalidationTarget[];
};

/** Declarative writes and invalidations for one response. */
type ForeignWriteTarget<TOwnerKey extends string, TTarget> = TTarget extends { readonly key: infer TKey }
  ? string extends TOwnerKey
    ? TTarget
    : TKey extends TOwnerKey
      ? never
      : TTarget
  : TTarget;

export type WritePlan<TOwnerKey extends string = never> = {
  /** Declares rows to insert or replace in a model. */
  upsert<TTarget extends AnyWriteTarget>(
    model: ForeignWriteTarget<TOwnerKey, TTarget>,
    rowOrRows: WriteTargetInput<TTarget> | readonly WriteTargetInput<TTarget>[]
  ): void;
  /** Declares a partial update for one stored row. */
  update<TTarget extends AnyWriteTarget>(
    model: ForeignWriteTarget<TOwnerKey, TTarget>,
    id: string,
    patch: Partial<WriteTargetStored<TTarget>>
  ): void;
  /** Declares destruction of one or more stored rows. */
  destroy<TTarget extends AnyWriteTarget>(
    model: ForeignWriteTarget<TOwnerKey, TTarget>,
    idOrIds: string | readonly string[]
  ): void;
  /** Declares a post-commit invalidation. */
  invalidate(target: InvalidationTarget): void;
};
