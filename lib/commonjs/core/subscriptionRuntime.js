"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getDbSubscriptionEffect = exports.defineDbSubscriptionEntry = exports.createDbSubscriptionRuntime = exports.createDbSubscriptionEffects = void 0;
var _subscriptionEffects = require("./subscriptionEffects.js");
var _subscriptionEntry = require("./subscriptionEntry.js");
var _subscriptionLifecycle = require("./subscriptionLifecycle.js");
/** Resolve an injected subscription effect by its stable application name. */
const getDbSubscriptionEffect = name => (0, _subscriptionEffects.getSubscriptionEffect)(name);

/**
 * Define a typed subscription entry for a heterogeneous runtime registry.
 *
 * @param entry Typed document, root-field key, variables, debounce, and payload handler.
 * @returns Runtime subscription entry accepted by `createDbSubscriptionRuntime`.
 */
exports.getDbSubscriptionEffect = getDbSubscriptionEffect;
const defineDbSubscriptionEntry = entry => (0, _subscriptionEntry.eraseTypedDbSubscriptionEntry)(entry);

/**
 * Create an injectable effects channel for subscription entries.
 *
 * @param noopEffects Complete effect table with no-op implementations.
 * @returns Stable effects table plus configure and reset controls.
 */
exports.defineDbSubscriptionEntry = defineDbSubscriptionEntry;
const createDbSubscriptionEffects = noopEffects => (0, _subscriptionEffects.createSubscriptionEffects)(noopEffects);

/**
 * Create a plain subscription runtime over the configured DB transport.
 *
 * @param entries Static subscription entries.
 * @returns Runtime controller for activation, dispatch, inspection, and teardown.
 */
exports.createDbSubscriptionEffects = createDbSubscriptionEffects;
const createDbSubscriptionRuntime = entries => (0, _subscriptionLifecycle.createSubscriptionLifecycle)(entries);
exports.createDbSubscriptionRuntime = createDbSubscriptionRuntime;
//# sourceMappingURL=subscriptionRuntime.js.map