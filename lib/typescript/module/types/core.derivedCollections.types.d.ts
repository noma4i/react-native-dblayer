/** Minimum a derived collection must offer its cache: the ability to be disposed. */
export type DerivedCollection = {
    cleanup(): Promise<void> | void;
};
/** Reference-counted cache of collections derived from a store. */
export type DerivedCollectionCache<TCollection extends DerivedCollection> = {
    /** Collection currently held for this key, without taking a reference. */
    peek(key: string): TCollection | undefined;
    /** Take a reference, building the collection when this is the first reader. */
    acquire(key: string, build: () => TCollection): {
        collection: TCollection;
        release(): void;
    };
    /** Drop every held collection; used when the store itself goes away. */
    disposeAll(): void;
};
//# sourceMappingURL=core.derivedCollections.types.d.ts.map