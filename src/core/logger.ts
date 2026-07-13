import type { DbLogger } from '../types';
import { createConfiguredSlot } from './configuredSlot';

export type { DbLogger };

const noop = (): void => {};

const defaultDbLogger: DbLogger = {
  debug: noop,
  error: noop
};

const currentDbLogger = createConfiguredSlot(defaultDbLogger);

/** Set the logger used by request and mutation runtimes. */
export const setDbLogger = (logger: DbLogger): void => {
  currentDbLogger.set(logger);
};

/** Get the currently configured logger. */
export const getDbLogger = (): DbLogger => currentDbLogger.get();
