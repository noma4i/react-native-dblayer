import React, { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getDbRuntimeConfig } from './configure';
import { bootDb, suspendDb } from './lifecycle';
import { noteResumeDrain } from '../core/diagnostics';
import { resumeFetchLedgers } from '../core/fetch/fetchLedgerRegistry';

export type DbProviderProps = {
  /** Application subtree that may read the database after boot completes. */
  children: React.ReactNode;
};

/**
 * Provide the boot gate and foreground-resume dispatcher for coordinator-owned reads.
 *
 * @param props Application subtree that becomes available after boot.
 * @returns Booted application subtree, or null while boot is pending.
 */
export const DbProvider = ({ children }: DbProviderProps) => {
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<unknown>(null);
  const bootPromise = useRef<ReturnType<typeof bootDb> | null>(null);
  const previousAppState = useRef(AppState.currentState);
  const resumeDrainGeneration = useRef(0);

  if (bootError) throw bootError;

  useEffect(() => {
    let mounted = true;
    bootPromise.current ??= bootDb();
    void bootPromise.current
      .then(() => {
        if (mounted) setBooted(true);
      })
      .catch(error => {
        if (mounted) setBootError(error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const previousState = previousAppState.current;
      if (state === 'active' && (previousState === 'background' || previousState === 'inactive')) {
        const generation = ++resumeDrainGeneration.current;
        const chunkSize = getDbRuntimeConfig().defaults.resumeRefetch?.chunkSize ?? 4;
        if (chunkSize <= 0) throw new Error(`react-native-dblayer: defaults.resumeRefetch.chunkSize must be a positive integer, received ${chunkSize}`);
        void resumeFetchLedgers(chunkSize, () => resumeDrainGeneration.current === generation).then(noteResumeDrain);
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
  }, []);

  return booted ? children : null;
};
