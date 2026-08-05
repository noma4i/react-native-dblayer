"use strict";

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getApplyRuntime, getDbRuntimeConfig } from "./configure.js";
import { bootDb } from "./lifecycle.js";
import { noteResumeDrain } from "../core/diagnostics.js";
import { resumeFetchReaders } from "../core/fetch/fetchReaderRegistry.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";

/**
 * Provide the boot gate and foreground-resume dispatcher for coordinator-owned reads.
 *
 * @param props Application subtree that becomes available after boot.
 * @returns Booted application subtree, or null while boot is pending.
 */
export const DbProvider = ({
  children
}) => {
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState(null);
  const bootPromise = useRef(null);
  const previousAppState = useRef(AppState.currentState);
  const resumeDrainGeneration = useRef(0);
  if (bootError) throw bootError;
  useEffect(() => {
    let mounted = true;
    const bootCurrentGeneration = async () => {
      while (mounted) {
        const generationFence = createGenerationFence();
        bootPromise.current ??= bootDb();
        try {
          await bootPromise.current;
          if (!generationFence.isCurrent()) {
            bootPromise.current = null;
            continue;
          }
          setBooted(true);
          return;
        } catch (error) {
          if (!generationFence.isCurrent()) {
            bootPromise.current = null;
            continue;
          }
          setBootError(error);
          return;
        }
      }
    };
    void bootCurrentGeneration();
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    if (!booted) return;
    const subscription = AppState.addEventListener('change', state => {
      const previousState = previousAppState.current;
      if (state === 'active' && (previousState === 'background' || previousState === 'inactive')) {
        const drainGeneration = ++resumeDrainGeneration.current;
        const generationFence = createGenerationFence();
        const chunkSize = getDbRuntimeConfig().defaults.resumeRefetch?.chunkSize ?? 4;
        const isCurrent = () => resumeDrainGeneration.current === drainGeneration && generationFence.isCurrent();
        void resumeFetchReaders(chunkSize, isCurrent).then(refetched => {
          if (isCurrent()) noteResumeDrain(refetched);
        });
      } else if (state === 'background') {
        resumeDrainGeneration.current += 1;
        // The process may be killed while backgrounded: land the coalesced cache snapshots now.
        getApplyRuntime().flushCacheSnapshots();
      }
      previousAppState.current = state;
    });
    return () => {
      resumeDrainGeneration.current += 1;
      subscription.remove();
    };
  }, [booted]);
  return booted ? children : null;
};
//# sourceMappingURL=DbProvider.js.map