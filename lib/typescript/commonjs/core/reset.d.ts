/** Register in-memory runtime state that the kill-switch must clear. */
export declare const registerReset: (reset: () => void | Promise<void>) => (() => void);
/**
 * KILL-SWITCH: full invalidation in one call. Discards pending checkpoint snapshots, deletes every
 * persisted key under the library namespace, clears all registered in-memory state and notifies
 * every live subscriber. There is no partial/per-model variant - the host app decides when to pull
 * it (e.g. on logout).
 */
export declare const resetRuntime: () => Promise<void>;
//# sourceMappingURL=reset.d.ts.map