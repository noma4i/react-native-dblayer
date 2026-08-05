import type { Resetter, SyncResetter } from '../types';
import type { StorageResetEntry } from '../types/core.persistenceInternals.types';
/** Internal: schemaManifest injects the current-manifest entry builder at module init (cycle-free), so every sanctioned wipe re-manifests the namespace it leaves behind. */
export declare const registerCurrentManifestEntryProvider: (provider: () => StorageResetEntry) => void;
/**
 * Register in-memory runtime state that `resetRuntime`'s kill-switch must clear. `defineModel` calls this
 * automatically for its own planes; use it directly only for extra runtime state defined outside a model.
 *
 * @param reset Synchronous cleanup callback; `resetRuntime` throws if it returns a `Promise`.
 * @returns Unregister function - call it to stop the resetter from running on future resets.
 */
export declare const registerReset: <TReset extends Resetter>(reset: SyncResetter<TReset>) => (() => void);
/**
 * Keyed variant of {@link registerReset} for state owned by a re-runnable DEFINITION (a
 * `define*` call). Re-registering the same key REPLACES the previous resetter, so redefining a
 * query/model (e.g. Fast Refresh) never accumulates resetters for dead closures.
 *
 * @param key Stable definition identity, e.g. `query:<keyName>` or `model:<modelId>`.
 * @param reset Synchronous cleanup callback; `resetRuntime` throws if it returns a `Promise`.
 */
export declare const registerKeyedReset: <TReset extends Resetter>(key: string, reset: SyncResetter<TReset>) => void;
/** Internal: rebind all registered in-memory state to the current runtime config WITHOUT touching storage. `configureDb` re-entry runs this so no definition keeps planes hydrated from a previously configured storage. */
export declare const resetInMemoryRuntime: () => void;
/**
 * KILL-SWITCH: full invalidation in one call. Discards pending cache snapshots, deletes every
 * persisted key under the library namespace, restores the current persistence manifest (so writes
 * after the reset in the same process never leave an unmanifested store for the next boot to
 * classify as corruption), clears all registered in-memory state and notifies
 * every live subscriber. The commit bus `publishAll` is the single wake-up channel for mounted
 * readers: each one re-acquires its handle from the new generation, so the first post-reset render
 * already serves the new runtime's data without a remount. There is no partial/per-model variant -
 * the host app decides when to pull it (e.g. on logout). Fully synchronous by design: state is
 * clean the moment the call returns, with no deferred teardown to await - seeding and subsequent
 * reads can rely on it immediately. An async resetter is a registration error and throws. No-ops
 * when `configureDb` has never run - an unconfigured runtime is trivially clean. Every resetter
 * runs even when another throws; failures are rethrown together as an `AggregateError` after
 * storage and in-memory state are fully reset.
 */
export declare const resetRuntime: () => void;
/** Internal: the manifest-reset entry. Wipes the namespace like `resetRuntime`, then restores the carried entries (manifest, outbox, quarantine). */
export declare const resetRuntimeKeeping: (restore: readonly StorageResetEntry[]) => void;
/** Internal: finish a reset that a crash interrupted - the persisted intent record replays the wipe and its restore set. */
export declare const resumeInterruptedStorageReset: () => boolean;
//# sourceMappingURL=reset.d.ts.map