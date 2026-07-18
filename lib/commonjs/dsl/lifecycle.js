"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.suspendDb = exports.bootDb = void 0;
var _gc = require("../core/gc.js");
var _reset = require("../core/reset.js");
var _bootValidations = require("./bootValidations.js");
var _configure = require("./configure.js");
var _maintenanceRegistry = require("./maintenanceRegistry.js");
/**
 * Recommended app-startup sequence: `configureDb(options)`, then deferred definition validation, then
 * `replayJournal()` to recover any WAL-only writes from a crash, then `collectGarbage()` to reclaim
 * unreachable rows left over from that replay, then `purgeForeignStorageKeys()` to clear any
 * pre-migration/foreign storage keys - in exactly that order, once, before the first render that reads a model.
 *
 * Every model module MUST be imported (so `defineModel` has registered its apply target) before calling
 * this - `replayJournal` throws on a journal record whose model has no registered apply target, and that
 * throw is intentionally loud here: `bootDb` does not catch or swallow validation or replay errors, since a
 * silent partial boot is worse than a startup crash.
 *
 * `configureDb`, `replayJournal`, `collectGarbage`, and `purgeForeignStorageKeys` remain individually
 * exported as composable primitives for callers with a different startup sequencing need; `bootDb` is the
 * recommended path for the common case.
 *
 * Pass `wipe: true` to discard all persisted and in-memory library state (the `resetRuntime`
 * kill-switch) between validation and replay - boot then starts from an empty store. Use it for
 * consumer-side schema/cache-version bumps where stale persisted rows must not be rehydrated.
 *
 * @param options The exact `configureDb` options (transport, storage, queryClient, logger, defaults),
 * plus the boot-only `wipe` flag.
 * @returns `replayed` - the journal record count `replayJournal` recovered; `gc` - the `collectGarbage`
 * report for the post-replay sweep.
 */
const bootDb = async options => {
  const {
    wipe,
    ...config
  } = options;
  (0, _configure.configureDb)(config);
  (0, _bootValidations.runBootValidations)();
  if (wipe) (0, _reset.resetRuntime)();
  const replayed = await (0, _configure.replayJournal)();
  const gc = (0, _gc.collectGarbage)();
  (0, _configure.purgeForeignStorageKeys)();
  const maintenance = (0, _maintenanceRegistry.runModelMaintenance)();
  return {
    replayed,
    gc,
    maintenance
  };
};

/**
 * Recommended app-background/teardown sequence: `flushPersistence()` to write pending checkpoint
 * snapshots to storage now, then `collectGarbage()` to reclaim rows that became unreachable since the
 * last sweep. Call this on app background/inactive and before logout teardown (a full state wipe should
 * still go through `resetRuntime`'s kill-switch - `suspendDb` only flushes and reclaims, it never clears).
 *
 * Safe to call repeatedly, and safe to call before `configureDb` has run: `flushPersistence` no-ops when
 * there is nothing scheduled, and the `collectGarbage` sweep is skipped entirely before configuration
 * (there is nothing to reclaim yet).
 */
exports.bootDb = bootDb;
const suspendDb = () => {
  (0, _configure.flushPersistence)();
  if ((0, _configure.isDbConfigured)()) (0, _gc.collectGarbage)();
};
exports.suspendDb = suspendDb;
//# sourceMappingURL=lifecycle.js.map