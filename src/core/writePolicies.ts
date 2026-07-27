import { isIncomingNewer } from './invariants';
import { compareCodepoints } from './serialize';
import { isNonArrayRecord, readIsoDate, readNumericLike } from '../utils/normalizeHelpers';

export type WriteOrigin = 'snapshot' | 'event' | 'replace' | 'patch';

export type WriteCtx = { origin: WriteOrigin; operationId?: string };

export type GuardedOrigin = Exclude<WriteOrigin, 'replace'>;

/**
 * A closed predicate algebra for accepting monotonic group writes.
 *
 * - `newerBy: path` accepts when values at `path`, normalized through `readIsoDate`, pass the sole
 *   time arbiter `isIncomingNewer`.
 * - `tuple: [...paths]` accepts when the first differing path value is greater incoming, comparing
 *   numbers numerically and all other values with `compareCodepoints`.
 * - `nonEmpty: true` accepts when every group field is present and non-empty; empty incoming values
 *   retain the current group fields.
 * - `ladder` accepts when the incoming tier rank is not below the current rank; values outside all
 *   tiers rank `-1`, and an absent value on either side abstains and accepts.
 * - `present: path` accepts when the incoming path value is neither `null` nor `undefined`.
 * - `equal: path` accepts when incoming and current path values satisfy `Object.is`.
 * - `all` accepts when every nested specification accepts, including an empty list.
 * - `any` accepts when at least one nested specification accepts; an empty list rejects.
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

export type NestedKeyPolicy = 'server' | 'continuity' | 'nonEmpty' | 'positive';

export type WritePolicy =
  | 'server'
  | 'continuity'
  | { monotonic: MonotonicSpec; on?: readonly GuardedOrigin[] }
  | { snapshot: true }
  | { keys: Readonly<Record<string, NestedKeyPolicy>>; rest?: 'server' | 'continuity' };

/** A group accepts one policy or an ordered list; a rejected guard restores current fields before later policies run. */
export type WriteGroup = { fields: readonly string[]; policy: WritePolicy | readonly WritePolicy[] };

const isPresent = (value: unknown): boolean => {
  if (value == null) return false;
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (isNonArrayRecord(value)) return Object.keys(value).length > 0;
  return true;
};

/** Read a dot-separated object path without traversing arrays or throwing on absent intermediate values. */
const readPath = (row: Record<string, unknown>, path: string): unknown => {
  let value: unknown = row;
  for (const part of path.split('.')) {
    if (!isNonArrayRecord(value)) return undefined;
    value = value[part];
  }
  return value;
};

const compareTupleValue = (incoming: unknown, current: unknown): number => {
  if (incoming == null) return current == null ? 0 : -1;
  if (current == null) return 1;
  const incomingNumber = readNumericLike(incoming);
  const currentNumber = readNumericLike(current);
  if (incomingNumber !== undefined && currentNumber !== undefined) return incomingNumber - currentNumber;
  return compareCodepoints(String(incoming), String(current));
};

const isIncomingTupleNewer = (paths: readonly string[], incoming: Record<string, unknown>, previous: Record<string, unknown>): boolean => {
  for (const path of paths) {
    const comparison = compareTupleValue(readPath(incoming, path), readPath(previous, path));
    if (comparison !== 0) return comparison > 0;
  }
  return false;
};

const isIncomingNewerBy = (path: string, incoming: Record<string, unknown>, previous: Record<string, unknown>): boolean =>
  isIncomingNewer(readIsoDate(readPath(previous, path)), readIsoDate(readPath(incoming, path)));

const ladderRank = (value: unknown, tiers: readonly (readonly string[])[]): number => tiers.findIndex(tier => tier.includes(String(value)));

const acceptsMonotonic = (spec: MonotonicSpec, fields: readonly string[], incoming: Record<string, unknown>, previous: Record<string, unknown>): boolean => {
  if ('newerBy' in spec) return isIncomingNewerBy(spec.newerBy, incoming, previous);
  if ('tuple' in spec) return isIncomingTupleNewer(spec.tuple, incoming, previous);
  if ('nonEmpty' in spec) return fields.every(field => field in incoming && isPresent(incoming[field]));
  if ('ladder' in spec) {
    const incomingValue = readPath(incoming, spec.ladder.path);
    const previousValue = readPath(previous, spec.ladder.path);
    return incomingValue === undefined || previousValue === undefined || ladderRank(incomingValue, spec.ladder.tiers) >= ladderRank(previousValue, spec.ladder.tiers);
  }
  if ('present' in spec) return readPath(incoming, spec.present) != null;
  if ('equal' in spec) return Object.is(readPath(incoming, spec.equal), readPath(previous, spec.equal));
  if ('all' in spec) return spec.all.every(item => acceptsMonotonic(item, fields, incoming, previous));
  return spec.any.some(item => acceptsMonotonic(item, fields, incoming, previous));
};

const appliesMonotonic = (policy: Extract<WritePolicy, { monotonic: MonotonicSpec; on?: readonly GuardedOrigin[] }>, origin: WriteOrigin): boolean =>
  origin !== 'replace' && (policy.on ?? ['snapshot', 'event']).includes(origin);

const applyNestedKeyPolicy = (current: unknown, incoming: unknown, policy: NestedKeyPolicy): unknown => {
  if (policy === 'server') return incoming;
  if (policy === 'continuity') return incoming == null ? current : incoming;
  if (policy === 'nonEmpty') return isPresent(incoming) ? incoming : current;
  const currentNumber = readNumericLike(current);
  const incomingNumber = readNumericLike(incoming);
  return incomingNumber === undefined || incomingNumber <= 0 ? (currentNumber !== undefined && currentNumber > 0 ? current : incoming) : incoming;
};

const applyNestedKeys = (previousValue: unknown, incomingValue: unknown, policy: Extract<WritePolicy, { keys: Readonly<Record<string, NestedKeyPolicy>> }>): unknown => {
  if (!isNonArrayRecord(incomingValue) || !isNonArrayRecord(previousValue)) return incomingValue;
  const result: Record<string, unknown> = { ...previousValue, ...incomingValue };
  for (const key of Object.keys(incomingValue)) {
    const keyPolicy = policy.keys[key] ?? policy.rest ?? 'server';
    result[key] = applyNestedKeyPolicy(previousValue[key], incomingValue[key], keyPolicy);
  }
  return result;
};

const applyPolicy = (policy: WritePolicy, fields: readonly string[], previous: Record<string, unknown>, effective: Record<string, unknown>, ctx: WriteCtx): void => {
  if (policy === 'server') return;
  if (policy === 'continuity') {
    for (const field of fields) if (field in effective && effective[field] == null) effective[field] = previous[field];
    return;
  }
  if ('snapshot' in policy) {
    for (const field of fields) if (field in effective) effective[field] = isNonArrayRecord(previous[field]) && isNonArrayRecord(effective[field]) ? { ...previous[field], ...effective[field] } : effective[field];
    return;
  }
  if ('keys' in policy) {
    for (const field of fields) if (field in effective) effective[field] = applyNestedKeys(previous[field], effective[field], policy);
    return;
  }
  if (!appliesMonotonic(policy, ctx.origin)) return;
  if (!acceptsMonotonic(policy.monotonic, fields, effective, previous)) {
    for (const field of fields) effective[field] = previous[field];
  }
};

/**
 * Compile a closed, model-owned write declaration into the sole entity write gate.
 *
 * Monotonic policies run only for `snapshot` and `event` unless `on` narrows those origins; replace
 * remains authoritative. `server` uses incoming values, `continuity` retains nullish values,
 * `snapshot` shallow-folds objects, and nested-key policies protect declared object keys. `newerBy`
 * normalizes values through `readIsoDate` before `isIncomingNewer`.
 */
export const compileWritePolicies = <TRow extends Record<string, unknown>>(groups: readonly WriteGroup[]) =>
  (previous: TRow, incoming: TRow, ctx: WriteCtx): TRow => {
    const effective: Record<string, unknown> = { ...previous, ...incoming };
    if (ctx.origin === 'replace') return effective as TRow;
    for (const group of groups) {
      const policies = Array.isArray(group.policy) ? group.policy : [group.policy];
      for (const policy of policies) applyPolicy(policy, group.fields, previous, effective, ctx);
    }
    return effective as TRow;
  };
