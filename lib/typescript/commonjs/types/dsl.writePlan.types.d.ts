import type { WriteOp } from './core.apply.journal.types';
/** Registered model target accepted by a write plan. */
export type WriteTarget<TInput, TStored extends {
    id: string;
}> = {
    build(input: TInput): TStored;
};
/** Post-commit callback that can invalidate a consumer-owned read. */
export type InvalidationTarget = {
    invalidate(): void;
};
export type RuntimeWriteTarget = WriteTarget<unknown, {
    id: string;
}>;
export type WriteIntent = {
    kind: 'upsert';
    model: object;
    rows: unknown[];
} | {
    kind: 'update';
    model: object;
    id: unknown;
    patch: unknown;
} | {
    kind: 'destroy';
    model: object;
    ids: unknown[];
} | {
    kind: 'invalidate';
    target: InvalidationTarget;
};
export type WritePlanCollectorOptions = {
    origin?: Extract<WriteOp, {
        kind: 'upsert';
    }>['origin'];
};
export type CompiledWritePlan = {
    writeOps: WriteOp[];
    invalidations: InvalidationTarget[];
};
/** Declarative writes and invalidations for one response. */
export type WritePlan = {
    /** Declares rows to insert or replace in a model. */
    upsert<TInput, TStored extends {
        id: string;
    }>(model: WriteTarget<TInput, TStored>, rowOrRows: TInput | readonly TInput[]): void;
    /** Declares a partial update for one stored row. */
    update<TInput, TStored extends {
        id: string;
    }>(model: WriteTarget<TInput, TStored>, id: string, patch: Partial<TStored>): void;
    /** Declares destruction of one or more stored rows. */
    destroy<TInput, TStored extends {
        id: string;
    }>(model: WriteTarget<TInput, TStored>, idOrIds: string | readonly string[]): void;
    /** Declares a post-commit invalidation. */
    invalidate(target: InvalidationTarget): void;
};
//# sourceMappingURL=dsl.writePlan.types.d.ts.map