/** Register runtime state that must clear on logout and account changes. */
export declare const registerReset: (reset: () => void | Promise<void>) => (() => void);
/** Reset every registered v6 state plane. */
export declare const resetRuntime: () => Promise<void>;
//# sourceMappingURL=reset.d.ts.map