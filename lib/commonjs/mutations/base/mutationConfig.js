"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.resolveMutationLogPrefix = exports.resolveMutationKey = exports.resolveCommandLogPrefix = exports.resolveCommandKey = exports.capitalize = void 0;
/** Capitalize the first character; returns falsy input unchanged. */
const capitalize = value => {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
};
exports.capitalize = capitalize;
const resolveMutationKey = config => config.key ? config.key() : [config.resultField];
exports.resolveMutationKey = resolveMutationKey;
const resolveMutationLogPrefix = config => config.logPrefix ?? capitalize(config.resultField);
exports.resolveMutationLogPrefix = resolveMutationLogPrefix;
const resolveCommandKey = (config, fallback = 'command') => config.key ? config.key() : [fallback];
exports.resolveCommandKey = resolveCommandKey;
const resolveCommandLogPrefix = (config, fallback = 'command') => config.logPrefix ?? capitalize(fallback);
exports.resolveCommandLogPrefix = resolveCommandLogPrefix;
//# sourceMappingURL=mutationConfig.js.map