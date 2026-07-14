export type IngestDecl = {
    upsert?: unknown | unknown[];
    destroy?: string | string[];
    invalidate?: boolean;
};
export type IngestHandle = {
    apply(event: string, payload: unknown): IngestDecl | null;
};
type IngestModel = {
    insertStored(row: {
        id: string;
    }): void;
    destroyMany(ids: string[]): void;
    invalidate(scope?: unknown): void;
};
/** Compile a subscription declaration through the same public model write channel as mutations. */
export declare const defineIngest: <TStored>(model: IngestModel, handlers: Record<string, (payload: unknown) => IngestDecl | null>) => IngestHandle;
export {};
//# sourceMappingURL=defineIngest.d.ts.map