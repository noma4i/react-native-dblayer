// React Native defines `window` as an alias of the global object, and React Query reads
// `typeof window === 'undefined'` once at module load to decide it is running on a server. Without
// this the suite runs the query runtime in server mode, where it schedules no timers and subscribes
// to no focus or network events - so every scheduling behaviour would look correct by being absent.
globalThis.window ??= globalThis;
