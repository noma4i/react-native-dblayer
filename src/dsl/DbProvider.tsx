import React, { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { getInternalQueryClient } from './configure';
import { bootDb, suspendDb, type BootDbOptions } from './lifecycle';

export type DbProviderProps = {
  /** Application subtree that may read the database after boot completes. */
  children: React.ReactNode;
  /** Data lifecycle options forwarded to `bootDb` once on mount. */
  bootOptions?: BootDbOptions;
};

/**
 * Provide the library-owned query client and gate database consumers until boot completes.
 *
 * @param props Children plus optional boot-only lifecycle options.
 * @returns The internal query provider with children after a successful boot, otherwise no children.
 */
export const DbProvider = ({ children, bootOptions }: DbProviderProps) => {
  const [booted, setBooted] = useState(false);
  const queryClient = getInternalQueryClient();
  const bootPromise = useRef<ReturnType<typeof bootDb> | null>(null);

  useEffect(() => {
    let mounted = true;
    bootPromise.current ??= bootDb(bootOptions);
    void bootPromise.current.then(() => {
      if (mounted) setBooted(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    focusManager.setFocused(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        focusManager.setFocused(true);
      } else if (state === 'background') {
        focusManager.setFocused(false);
        suspendDb();
      }
    });
    return () => subscription.remove();
  }, []);

  return <QueryClientProvider client={queryClient}>{booted ? children : null}</QueryClientProvider>;
};
