"use strict";

import { useMutation } from '@tanstack/react-query';
import { getDbLogger } from "../../core/logger.js";
import { resolveCommandKey, resolveCommandLogPrefix } from "./mutationConfig.js";
import { createSingleFlightSignature, runSingleFlight } from "./singleFlight.js";

/**
 * React hook primitive for command-style mutations with opt-in single-flight dedupe.
 * @param config Command mutation function, key, logging, and lifecycle callbacks.
 * @returns React Query mutation result.
 */
export const useCommandMutation = config => useMutation({
  mutationKey: resolveCommandKey(config),
  mutationFn: input => {
    const commandKey = resolveCommandKey(config);
    const logPrefix = resolveCommandLogPrefix(config);
    const executeCommand = () => {
      getDbLogger().debug(logPrefix, 'mutationFn start');
      return config.mutationFn(input);
    };
    const dedupeKey = config.dedupe?.key(input);
    if (dedupeKey == null) {
      return executeCommand();
    }
    return runSingleFlight(createSingleFlightSignature('command-mutation', commandKey, dedupeKey), executeCommand);
  },
  onSuccess: (data, input) => {
    config.onSuccess?.(data, input);
  },
  onError: (error, input) => {
    config.onError?.(error, input);
    getDbLogger().error(resolveCommandLogPrefix(config), 'onError', error);
  },
  onSettled: () => {
    config.onSettled?.();
  }
});
//# sourceMappingURL=useCommandMutation.js.map