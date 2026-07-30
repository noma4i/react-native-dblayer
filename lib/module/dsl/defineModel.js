"use strict";

import { defineModelFacade } from "./defineModelFacade.js";

/**
 * Define one class-like persistent model.
 *
 * @param key Stable model identity used by storage, dependencies, and diagnostics.
 * @param config Schema, associations, named relations, actions, sideloads, policies, and statics.
 * @returns A model singleton with local reads/writes, flat relations, and model-owned actions.
 */
export const defineModel = (key, config) => defineModelFacade(key, config);
//# sourceMappingURL=defineModel.js.map