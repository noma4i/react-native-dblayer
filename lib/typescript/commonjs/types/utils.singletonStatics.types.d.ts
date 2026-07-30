export type RowId = {
    id: string;
};
export type PatchModel<TStored extends RowId> = {
    find(id: string): TStored | undefined;
    update(id: string, updates: Partial<TStored>): boolean | void;
};
export type SingletonModel<TStored extends RowId> = PatchModel<TStored> & {
    insert(item: TStored): void;
    useFind(id: string | null | undefined, options?: {
        renderKeys?: readonly (keyof TStored & string)[];
    }): TStored | undefined;
};
export type NumericField<TStored> = {
    [K in keyof TStored]: TStored[K] extends number ? K : never;
}[keyof TStored];
/** Singleton model statics built by `createSingletonStatics`. */
export type SingletonStatics<TStored extends RowId> = {
    recordId: string;
    defaults: TStored;
    current(): TStored | undefined;
    useCurrent(): TStored;
    useCurrentField<TField extends keyof TStored & string>(field: TField): TStored[TField];
    upsertCurrent(input: Partial<TStored>): void;
    updateClamped<TField extends Extract<NumericField<TStored>, string>>(field: TField, delta: number, min?: number): boolean;
};
//# sourceMappingURL=utils.singletonStatics.types.d.ts.map