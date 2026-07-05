import type { DbModelDefaults } from '../types';

let dbModelDefaults: DbModelDefaults = {};

export const getDbModelDefaults = (): DbModelDefaults => dbModelDefaults;

export const setDbModelDefaults = (defaults?: DbModelDefaults): void => {
  dbModelDefaults = defaults ?? {};
};
