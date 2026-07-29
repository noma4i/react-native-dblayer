export type Resetter = () => unknown;
export type SyncResetter<TReset extends Resetter> = [ReturnType<TReset>] extends [never] ? TReset : TReset & (ReturnType<TReset> extends PromiseLike<unknown> ? never : unknown);
//# sourceMappingURL=core.reset.types.d.ts.map
