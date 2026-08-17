"use strict";

/**
 * Definition registry of optimistic-insert planners (one per request action with an insert root).
 * Boot fsck rebuilds the temp row of a crashed insert operation from its ledger input through THE
 * planner the action itself uses for run and retry, so a kill or a cache reset between the ledger
 * write and the row write never leaves a retryable draft invisible. Definition registries survive
 * `resetRuntime`: declarations describe behavior, not runtime rows.
 */
const planners = new Map();
export const registerOptimisticInsertPlanner = (modelId, actionKey, planner) => {
  const entries = planners.get(modelId) ?? new Map();
  entries.set(actionKey, planner);
  planners.set(modelId, entries);
};

/** The optimistic row plan of one action for one ledger input, or null when the action declares no insert root. */
export const planOptimisticInsert = (modelId, actionKey, input, tempId, operationId) => {
  const planner = planners.get(modelId)?.get(actionKey);
  return planner ? planner(input, tempId, operationId) : null;
};
//# sourceMappingURL=optimisticInsertPlanners.js.map