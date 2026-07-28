export type WriteOrigin = 'snapshot' | 'event' | 'replace' | 'patch';

export type WriteCtx = {
  origin: WriteOrigin;
  operationId?: string;
};

export type GuardedOrigin = Exclude<WriteOrigin, 'replace'>;

export type MonotonicSpec =
  | { newerBy: string }
  | { tuple: readonly [string, ...string[]] }
  | { nonEmpty: true }
  | { ladder: { path: string; tiers: readonly (readonly string[])[] } }
  | { present: string }
  | { equal: string }
  | { all: readonly MonotonicSpec[] }
  | { any: readonly MonotonicSpec[] };

export type NestedKeyPolicy = 'server' | 'continuity' | 'nonEmpty' | 'positive';

export type WritePolicy =
  | 'server'
  | 'continuity'
  | { monotonic: MonotonicSpec; on?: readonly GuardedOrigin[] }
  | { snapshot: true }
  | { keys: Readonly<Record<string, NestedKeyPolicy>>; rest?: 'server' | 'continuity' };

export type WriteGroup = { fields: readonly string[]; policy: WritePolicy | readonly WritePolicy[] };
