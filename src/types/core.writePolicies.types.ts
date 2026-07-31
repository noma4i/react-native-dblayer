export type WriteOrigin = 'snapshot' | 'event' | 'replace' | 'patch';

/** Origin plus optional operation id for write-policy evaluation. */
export type WriteCtx = {
  origin: WriteOrigin;
  operationId?: string;
};

/** Write origins that still allow monotonic policies to run. */
export type GuardedOrigin = Exclude<WriteOrigin, 'replace'>;

/**
 * Closed predicate algebra for accepting monotonic group writes.
 *
 * - `newerBy: path` compares normalized date values with `isIncomingNewer`.
 * - `tuple: [...paths]` compares the first differing path value, using numeric comparison when both
 *   sides are numeric-like and codepoint comparison otherwise.
 * - `nonEmpty: true` requires every group field to be present and non-empty.
 * - `ladder` accepts when the incoming tier rank is not below the current rank; unranked incoming
 *   values reject and record a data-loss event.
 * - `present: path` requires a non-nullish incoming value.
 * - `equal: path` requires `Object.is` equality between incoming and current values.
 * - `all` accepts only when every nested spec accepts.
 * - `any` accepts when at least one nested spec accepts.
 */
export type MonotonicSpec =
  | { newerBy: string }
  | { tuple: readonly [string, ...string[]] }
  | { nonEmpty: true }
  | { ladder: { path: string; tiers: readonly (readonly string[])[] } }
  | { present: string }
  | { equal: string }
  | { all: readonly MonotonicSpec[] }
  | { any: readonly MonotonicSpec[] };

/** Nested-key policy applied to object-valued write fields. */
export type NestedKeyPolicy = 'server' | 'continuity' | 'nonEmpty' | 'positive';

/** Policy shape accepted by a grouped write declaration. */
export type WritePolicy =
  | 'server'
  | 'local'
  | 'continuity'
  | { monotonic: MonotonicSpec; on?: readonly GuardedOrigin[] }
  | { snapshot: true }
  | { keys: Readonly<Record<string, NestedKeyPolicy>>; rest?: 'server' | 'continuity' };

/** A grouped field declaration and its ordered policy set. */
export type WriteGroup = { fields: readonly string[]; policy: WritePolicy | readonly WritePolicy[] };
