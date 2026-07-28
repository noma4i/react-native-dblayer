"use strict";

import { createSubscriptionEffects, getSubscriptionEffect } from "./subscriptionEffects.js";
import { eraseTypedDbSubscriptionEntry } from "./subscriptionEntry.js";
import { createSubscriptionLifecycle } from "./subscriptionLifecycle.js";
/** Resolve an injected subscription effect by its stable application name. */
export const getDbSubscriptionEffect = name => getSubscriptionEffect(name);

/**
 * Define a typed subscription entry for a heterogeneous runtime registry.
 *
 * @param entry Typed document, root-field key, variables, debounce, and payload handler.
 * @returns Runtime subscription entry accepted by `createDbSubscriptionRuntime`.
 */
export const defineDbSubscriptionEntry = entry => eraseTypedDbSubscriptionEntry(entry);

/**
 * Create an injectable effects channel for subscription entries.
 *
 * @param noopEffects Complete effect table with no-op implementations.
 * @returns Stable effects table plus configure and reset controls.
 */
export const createDbSubscriptionEffects = noopEffects => createSubscriptionEffects(noopEffects);

/**
 * Create a plain subscription runtime over the configured DB transport.
 *
 * @param entries Static subscription entries.
 * @returns Runtime controller for activation, dispatch, inspection, and teardown.
 */
export const createDbSubscriptionRuntime = entries => createSubscriptionLifecycle(entries);
//# sourceMappingURL=subscriptionRuntime.js.map