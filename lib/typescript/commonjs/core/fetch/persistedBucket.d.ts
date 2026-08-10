import type { QueryKey } from '@tanstack/react-query';
import type { QueryPersistenceDeclaration, QueryPersistenceRecord } from '../../types';
/**
 * Move one bucket between storage and the query cache.
 *
 * Both reader surfaces land and store buckets the same way, and the parts that must agree are the
 * quiet ones: a record outside its window is discarded rather than shown, the stored timestamp
 * decides freshness instead of the moment of restore, and an invalidation that landed while the app
 * was closed is replayed. A second copy of this is how one surface starts trusting a record the
 * other would have thrown away.
 */
export declare const restorePersistedBucket: <TPayload, TCached, TScope>(args: {
    declaration: QueryPersistenceDeclaration;
    identity: string;
    queryKey: QueryKey;
    /** Rejects a record that does not belong to this identity; throwing drops and reports it. */
    validate: (record: QueryPersistenceRecord) => {
        payload: TPayload;
        scope: TScope;
    };
    /** The shape the reader caches; the stored record decides the window, not this value. */
    cache: (payload: TPayload) => TCached;
    /** Reconcile valid metadata with its current destination before it reaches the query cache. */
    reconcile: (record: QueryPersistenceRecord<TPayload, TScope>) => QueryPersistenceRecord<TPayload, TScope>;
    /** Report a failed best-effort rewrite without rejecting the salvaged in-memory result. */
    onRewriteError: (error: unknown) => void;
    window: (empty: boolean) => number | null;
}) => TCached | undefined;
/**
 * Store one landed bucket, or drop the stored one when this payload may not outlive the session.
 *
 * @see restorePersistedBucket for why both surfaces share this.
 */
export declare const persistBucket: <TPayload, TScope>(args: {
    declaration: QueryPersistenceDeclaration;
    identity: string;
    scope: TScope;
    payload: TPayload;
    empty: boolean;
    dataUpdatedAt: number;
    invalidated: boolean;
    window: (empty: boolean) => number | null;
    invalidationRevision?: number;
    onError?: (error: unknown) => void;
}) => void;
//# sourceMappingURL=persistedBucket.d.ts.map