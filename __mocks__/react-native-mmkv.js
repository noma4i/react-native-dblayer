// The fake implementation lives in mmkvMockFactory.ts, type-bound to the real react-native-mmkv
// package (`ReturnType<typeof createMMKV>`) so an API drift fails tsc instead of a silent boot crash.
const { createMockMmkv } = require('./mmkvMockFactory');

exports.createMMKV = createMockMmkv;
