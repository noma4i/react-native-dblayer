import type { DbLogger } from '../types';

export type { DbLogger };

const noop = (): void => {};

const defaultDbLogger: DbLogger = {
  debug: noop,
  error: noop
};

let currentDbLogger: DbLogger = defaultDbLogger;

/** Set the logger used by request and mutation runtimes. */
export const setDbLogger = (logger: DbLogger): void => {
  currentDbLogger = logger;
};

/** Get the currently configured logger. */
export const getDbLogger = (): DbLogger => currentDbLogger;
