"use strict";

import { createConfiguredSlot } from "./configuredSlot.js";
const dbModelDefaults = createConfiguredSlot({});
export const getDbModelDefaults = () => dbModelDefaults.get();
export const setDbModelDefaults = defaults => {
  dbModelDefaults.set(defaults ?? {});
};
//# sourceMappingURL=modelDefaults.js.map