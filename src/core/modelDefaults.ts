import type { DbModelDefaults } from '../types';
import { createConfiguredSlot } from './configuredSlot';

const dbModelDefaults = createConfiguredSlot<DbModelDefaults>({});

export const getDbModelDefaults = (): DbModelDefaults => dbModelDefaults.get();

export const setDbModelDefaults = (defaults?: DbModelDefaults): void => {
  dbModelDefaults.set(defaults ?? {});
};
