import type { ScopeIndexValue } from './core.planes.scopeIndex.types';
import type { StoredRow } from './core.relations.types';
import type { OperationTransition } from './core.planes.operationState.types';
/** Raw model-owned intent accepted by the write-plan compiler. */
export type WriteOp = {
    kind: 'upsert';
    model: string;
    rows: unknown[];
    origin?: 'event';
    operationId?: string;
    mergeBase?: never;
    baseRevision?: number;
}
/** Replace carries the prior row only through planning so write groups observe the same commit semantics. */
 | {
    kind: 'upsert';
    model: string;
    rows: unknown[];
    origin: 'replace';
    mergeBase?: unknown;
    operationId?: string;
    baseRevision?: number;
}
/** `operationId` lets a pending optimistic method-patch plan its own rollback while foreign patches keep its owned fields. */
 | {
    kind: 'patch';
    model: string;
    id: string;
    patch: Record<string, unknown>;
    remove?: string[];
    operationId?: string;
    baseRevision?: number;
}
/** `replace` marks the destroy half of an identity swap during relation planning. */
 | {
    kind: 'destroy';
    model: string;
    ids: string[];
    tombstone?: boolean;
    origin?: 'replace';
    replacedBy?: string;
    operationTransitions?: OperationTransition[];
    baseRevision?: number;
} | {
    kind: 'scope';
    model: string;
    scopeKey: string;
    next: ScopeIndexValue;
} | {
    kind: 'scope-delta';
    model: string;
    scopeKey: string;
    append: Array<{
        id: string;
        orderKey?: string;
    }>;
    detach: string[];
} | {
    kind: 'counter';
    model: string;
    id: string;
    field: string;
    delta: number;
};
/** Callback-free operation applied and persisted verbatim by one commit. */
export type AppliedOp = {
    kind: 'upsert';
    model: string;
    rows: StoredRow[];
    origin?: 'replace';
} | {
    kind: 'destroy';
    model: string;
    ids: string[];
    tombstone?: boolean;
    origin?: 'replace';
    replacedBy?: string;
} | {
    kind: 'scope';
    model: string;
    scopeKey: string;
    next: ScopeIndexValue;
} | {
    kind: 'scope-delta';
    model: string;
    scopeKey: string;
    append: Array<{
        id: string;
        orderKey: string;
    }>;
    detach: string[];
};
//# sourceMappingURL=core.apply.ops.types.d.ts.map