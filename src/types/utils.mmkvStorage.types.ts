import type { createMMKV } from 'react-native-mmkv';

/** Lazily-required `react-native-mmkv` module surface. */
export type MmkvModule = { createMMKV: typeof createMMKV };

/** One MMKV instance as returned by `createMMKV`. */
export type MmkvStorage = ReturnType<typeof createMMKV>;
