"use strict";

/** Capitalize the first character; returns falsy input unchanged. */
export const capitalize = value => {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
};
export const resolveMutationKey = config => config.key ? config.key() : [config.resultField];
export const resolveMutationLogPrefix = config => config.logPrefix ?? capitalize(config.resultField);
export const resolveCommandKey = (config, fallback = 'command') => config.key ? config.key() : [fallback];
export const resolveCommandLogPrefix = (config, fallback = 'command') => config.logPrefix ?? capitalize(fallback);
//# sourceMappingURL=mutationConfig.js.map