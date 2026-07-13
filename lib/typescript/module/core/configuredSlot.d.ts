/** Mutable configured-slot pair used by runtime seams (logger, transport, storage, query client, defaults, extract, tracking). */
export declare const createConfiguredSlot: <T>(defaultValue: T) => {
    get: () => T;
    set: (value: T) => void;
};
//# sourceMappingURL=configuredSlot.d.ts.map