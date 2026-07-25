import React, { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { getDbRuntimeConfig, getInternalQueryClient } from './configure';
import { bootDb, suspendDb, type BootDbOptions } from './lifecycle';
import { noteResumeDrain } from '../core/diagnostics';

const resolveResumeStaleTime = (query: Query, fallback: number | null): number | null => {
  const metaValue = query.meta?.resumeStaleTime;
  return typeof metaValue === 'number' || metaValue === null ? metaValue : fallback;
};

export type DbProviderProps = {
  /** Application subtree that may read the database after boot completes. */
  children: React.ReactNode;
  /** Data lifecycle options forwarded to `bootDb` once on mount. */
  bootOptions?: BootDbOptions;
};

/**
 * Provide the library-owned query client and gate database consumers until boot completes.
 *
 * A successful boot renders `children`. A rejected boot throws the rejection reason during
 * render (on the next render after the rejection is observed), so it surfaces as an ordinary
 * React render error instead of leaving consumers stuck behind a permanent `null` - `bootDb` is
 * intentionally fail-loud (see its JSDoc in `lifecycle.ts`), and this provider must not swallow
 * that by only handling the resolved case.
 *
 * @param props Children plus optional boot-only lifecycle options.
 * @returns The internal query provider with children after a successful boot; throws in render if boot rejected.
 */
export const DbProvider = ({ children, bootOptions }: DbProviderProps) => {
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<unknown>(null);
  const queryClient = getInternalQueryClient();
  const bootPromise = useRef<ReturnType<typeof bootDb> | null>(null);
  const previousAppState = useRef(AppState.currentState);
  const resumeDrainGeneration = useRef(0);

  if (bootError) throw bootError;

  useEffect(() => {
    let mounted = true;
    bootPromise.current ??= bootDb(bootOptions);
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
    focusManager.setFocused(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', state => {
      const previousState = previousAppState.current;
      if (state === 'active') {
        focusManager.setFocused(true);
        const resumeStaleTime = getDbRuntimeConfig().defaults.resumeStaleTime;
        if (previousState === 'background' || previousState === 'inactive') {
          const generation = ++resumeDrainGeneration.current;
          const resumedAt = Date.now();
          const predicate = (query: Query) => {
            const queryResumeStaleTime = resolveResumeStaleTime(query, resumeStaleTime);
            return (query.queryKey[0] === 'dbl' || query.queryKey[0] === 'dbl-fetch') && queryResumeStaleTime !== null && resumedAt - query.state.dataUpdatedAt > queryResumeStaleTime;
          };
          const staleQueries = queryClient.getQueryCache().findAll({ predicate });
          if (staleQueries.length > 0) {
            const staleQuerySet = new Set(staleQueries);
            const staleCandidate = (query: Query) => staleQuerySet.has(query);
            const activeQueries = staleQueries.filter(query => query.getObserversCount() > 0);
            const chunkSize = getDbRuntimeConfig().defaults.resumeRefetch?.chunkSize ?? 4;
            void (async () => {
              let refetched = 0;
              try {
                await queryClient.invalidateQueries({ predicate: staleCandidate, refetchType: 'none' });
                for (let index = 0; index < activeQueries.length; index += chunkSize) {
                  if (resumeDrainGeneration.current !== generation) return;
                  const chunk = activeQueries.slice(index, index + chunkSize);
                  refetched += chunk.length;
                  await Promise.allSettled(chunk.map(query => queryClient.refetchQueries({ queryKey: query.queryKey, exact: true })));
                }
              } finally {
                noteResumeDrain(refetched);
              }
            })();
          }
        }
      } else if (state === 'background') {
        resumeDrainGeneration.current += 1;
        focusManager.setFocused(false);
        suspendDb();
      }
      previousAppState.current = state;
    });
    return () => subscription.remove();
  }, []);

  return <QueryClientProvider client={queryClient}>{booted ? children : null}</QueryClientProvider>;
};
