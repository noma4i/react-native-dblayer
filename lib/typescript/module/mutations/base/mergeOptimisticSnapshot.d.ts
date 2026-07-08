export type MergeOptimisticFieldMerger = (optimisticValue: unknown, serverValue: unknown) => unknown;
export type MergeOptimisticSnapshotOptions<TOptimistic extends object, TServer extends object> = {
    fields?: Array<keyof (TOptimistic & TServer)>;
    mergers?: Partial<Record<keyof (TOptimistic & TServer), MergeOptimisticFieldMerger>>;
};
/**
 * Choose a committed field value while preserving useful optimistic placeholders.
 *
 * @param optimisticValue Existing optimistic field value.
 * @param serverValue Incoming server field value.
 * @returns The optimistic value when the server value is nullish or empty string, otherwise the server value.
 */
export declare const resolveMergedField: (optimisticValue: unknown, serverValue: unknown) => unknown;
/**
 * Merge an optimistic row snapshot with a committed server node.
 *
 * @param optimistic Optimistic row captured before commit.
 * @param server Server node returned by the mutation.
 * @param options Optional field allowlist and custom field mergers.
 * @returns The merged object, or whichever side exists when the other side is nullish.
 */
export declare const mergeOptimisticSnapshot: <TOptimistic extends object, TServer extends object>(optimistic: TOptimistic | null | undefined, server: TServer | null | undefined, options?: MergeOptimisticSnapshotOptions<TOptimistic, TServer>) => TOptimistic | TServer | (TOptimistic & TServer) | null | undefined;
//# sourceMappingURL=mergeOptimisticSnapshot.d.ts.map