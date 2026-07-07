export type MergeOptimisticFieldMerger = (optimisticValue: unknown, serverValue: unknown) => unknown;
export type MergeOptimisticSnapshotOptions<TOptimistic extends object, TServer extends object> = {
    fields?: Array<keyof (TOptimistic & TServer)>;
    mergers?: Partial<Record<keyof (TOptimistic & TServer), MergeOptimisticFieldMerger>>;
};
export declare const resolveMergedField: (optimisticValue: unknown, serverValue: unknown) => unknown;
export declare const mergeOptimisticSnapshot: <TOptimistic extends object, TServer extends object>(optimistic: TOptimistic | null | undefined, server: TServer | null | undefined, options?: MergeOptimisticSnapshotOptions<TOptimistic, TServer>) => TOptimistic | TServer | (TOptimistic & TServer) | null | undefined;
//# sourceMappingURL=mergeOptimisticSnapshot.d.ts.map