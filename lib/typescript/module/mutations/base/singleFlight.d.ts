export declare const serializeSingleFlightValue: (value: unknown) => string;
export declare const createSingleFlightSignature: (scope: string, mutationKey: readonly unknown[], payload: unknown) => string;
export declare const runSingleFlight: <T>(signature: string, execute: () => Promise<T>) => Promise<T>;
//# sourceMappingURL=singleFlight.d.ts.map