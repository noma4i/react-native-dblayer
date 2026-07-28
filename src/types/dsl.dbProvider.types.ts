import type { ReactNode } from 'react';

export type DbProviderProps = {
  /** Application subtree that may read the database after boot completes. */
  children: ReactNode;
};
