import type { DbTransport } from '../types';
import { createConfiguredSlot } from './configuredSlot';

export type { DbTransport };

const notConfigured = (): never => {
  throw new Error('react-native-dblayer: transport not configured - call setDbTransport(...) at app start');
};

const defaultDbTransport: DbTransport = {
  query: notConfigured,
  mutation: notConfigured
};

const currentDbTransport = createConfiguredSlot(defaultDbTransport);

/** Set the GraphQL transport used by query and mutation runtimes. */
export const setDbTransport = (transport: DbTransport): void => {
  currentDbTransport.set(transport);
};

/** Get the currently configured GraphQL transport. */
export const getDbTransport = (): DbTransport => currentDbTransport.get();
