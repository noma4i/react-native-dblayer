import React, { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getDbRuntimeConfig, getRuntimeGeneration } from './configure';
import { bootDb, suspendDb } from './lifecycle';
import { noteResumeDrain } from '../core/diagnostics';
import { resumeFetchReaders } from '../core/fetch/fetchReaderRegistry';
import type { DbProviderProps } from '../types';

/**
 * Provide the boot gate and foreground-resume dispatcher for coordinator-owned reads.
 *
 * @param props Application subtree that becomes available after boot.
 * @returns Booted application subtree, or null while boot is pending.
 */
export const DbProvider = ({ children }: DbProviderProps): React.ReactNode => {
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<unknown>(null);
  const bootPromise = useRef<ReturnType<typeof bootDb> | null>(null);
  const previousAppState = useRef(AppState.currentState);
  const resumeDrainGeneration = useRef(0);

  if (bootError) throw bootError;

  useEffect(() => {
    let mounted = true;
    const bootCurrentGeneration = async (): Promise<void> => {
      while (mounted) {
        const generation = getRuntimeGeneration();
        bootPromise.current ??= bootDb();
        try {
          await bootPromise.current;
          if (generation !== getRuntimeGeneration()) {
            bootPromise.current = null;
            continue;
          }
          setBooted(true);
          return;
        } catch (error) {
          if (generation !== getRuntimeGeneration()) {
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
        const runtimeGeneration = getRuntimeGeneration();
        const chunkSize = getDbRuntimeConfig().defaults.resumeRefetch?.chunkSize ?? 4;
        if (chunkSize <= 0) throw new Error(`react-native-dblayer: defaults.resumeRefetch.chunkSize must be a positive integer, received ${chunkSize}`);
        const isCurrent = (): boolean => resumeDrainGeneration.current === drainGeneration && getRuntimeGeneration() === runtimeGeneration;
        void resumeFetchReaders(chunkSize, isCurrent).then(refetched => {
          if (isCurrent()) noteResumeDrain(refetched);
        });
      } else if (state === 'background') {
        resumeDrainGeneration.current += 1;
        suspendDb();
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
