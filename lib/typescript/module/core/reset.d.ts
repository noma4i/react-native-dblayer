/** Register in-memory runtime state that the kill-switch must clear. */
export declare const registerReset: (reset: () => void | Promise<void>) => (() => void);
/**
 * KILL-SWITCH: full invalidation in one call. Discards pending checkpoint snapshots, deletes every
 * persisted key under the library namespace, clears all registered in-memory state and notifies
 * every live subscriber. There is no partial/per-model variant - the host app decides when to pull
 * it (e.g. on logout). Synchronous by design: state is clean the moment it returns (seeding and
 * teardown can rely on it); an async resetter is a registration error and throws.
 */
export declare const resetRuntimeSync: () => void;
/** Promise-shaped wrapper kept for call sites that await the kill-switch. */
export declare const resetRuntime: () => Promise<void>;
//# sourceMappingURL=reset.d.ts.map