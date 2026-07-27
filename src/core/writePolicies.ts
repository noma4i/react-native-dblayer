import { isIncomingNewer } from './invariants';
import { compareCodepoints } from './serialize';
import { isNonArrayRecord, readIsoDate, readNumericLike } from '../utils/normalizeHelpers';

export type WriteOrigin = 'snapshot' | 'event' | 'replace' | 'patch';

export type WriteCtx = { origin: WriteOrigin; operationId?: string };

type GuardedOrigin = Exclude<WriteOrigin, 'replace'>;

export type MonotonicSpec = { newerBy: string } | { tuple: readonly [string, ...string[]] } | { nonEmpty: true };

export type MediaPolicySpec = {
  dimensionKeys: readonly string[];
  sourceKeys: readonly string[];
  transcodeGuard?: { statusField: string; progressField?: string };
};

export type WritePolicy =
  | 'server'
  | 'continuity'
  | { monotonic: MonotonicSpec; on?: readonly GuardedOrigin[] }
  | { media: MediaPolicySpec }
  | { snapshot: true };

export type WriteGroup = { fields: readonly string[]; policy: WritePolicy };

const isPresent = (value: unknown): boolean => {
  if (value == null) return false;
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (isNonArrayRecord(value)) return Object.keys(value).length > 0;
  return true;
};

const compareTupleValue = (incoming: unknown, current: unknown): number => {
  if (incoming == null) return current == null ? 0 : -1;
  if (current == null) return 1;
  const incomingNumber = readNumericLike(incoming);
  const currentNumber = readNumericLike(current);
  if (incomingNumber !== undefined && currentNumber !== undefined) return incomingNumber - currentNumber;
  return compareCodepoints(String(incoming), String(current));
};

const isIncomingTupleNewer = (fields: readonly string[], incoming: Record<string, unknown>, previous: Record<string, unknown>): boolean => {
  for (const field of fields) {
    const comparison = compareTupleValue(incoming[field], previous[field]);
    if (comparison !== 0) return comparison > 0;
  }
  return false;
};

const isIncomingNewerBy = (field: string, incoming: Record<string, unknown>, previous: Record<string, unknown>): boolean =>
  isIncomingNewer(readIsoDate(previous[field]), readIsoDate(incoming[field]));

const appliesMonotonic = (policy: Extract<WritePolicy, { monotonic: MonotonicSpec; on?: readonly GuardedOrigin[] }>, origin: WriteOrigin): boolean =>
  origin !== 'replace' && (policy.on ?? ['snapshot', 'event']).includes(origin);

const terminalMediaStatuses = new Set(['ready', 'failed', 'completed']);

const preservesMedia = (previous: Record<string, unknown>, incoming: Record<string, unknown>, spec: MediaPolicySpec): boolean => {
  const guard = spec.transcodeGuard;
  if (!guard) return false;
  const previousStatus = previous[guard.statusField];
  const incomingStatus = incoming[guard.statusField];
  if (typeof previousStatus === 'string' && terminalMediaStatuses.has(previousStatus) && !terminalMediaStatuses.has(String(incomingStatus))) return true;
  if (!guard.progressField) return false;
  const previousProgress = readNumericLike(previous[guard.progressField]);
  const incomingProgress = readNumericLike(incoming[guard.progressField]);
  return previousProgress !== undefined && incomingProgress !== undefined && incomingProgress < previousProgress;
};

const mergeMedia = (previousValue: unknown, incomingValue: unknown, spec: MediaPolicySpec, origin: WriteOrigin): unknown => {
  if (incomingValue == null || !isNonArrayRecord(incomingValue)) return incomingValue;
  if (!isNonArrayRecord(previousValue)) return incomingValue;
  if (origin !== 'replace' && preservesMedia(previousValue, incomingValue, spec)) return previousValue;
  const merged: Record<string, unknown> = { ...previousValue, ...incomingValue };
  if (origin === 'replace') return merged;
  for (const key of spec.dimensionKeys) {
    const previous = readNumericLike(previousValue[key]);
    const incoming = readNumericLike(incomingValue[key]);
    if (previous !== undefined && previous > 0 && (incoming === undefined || incoming <= 0)) merged[key] = previousValue[key];
  }
  for (const key of spec.sourceKeys) {
    const previous = previousValue[key];
    const incoming = incomingValue[key];
    if (isPresent(previous) && !isPresent(incoming)) merged[key] = previous;
  }
  return merged;
};

/**
 * Compile a closed, model-owned write declaration into the sole entity write gate.
 *
 * Origin matrix: monotonic policies run only for `snapshot` and `event` unless their `on`
 * list narrows that set; media guards also run for `patch`. Neither guard runs on `replace`,
 * so a mutation commit is an authoritative server echo. `server` fields always use incoming
 * values, `continuity` retains current nullish writes, and `snapshot` shallow-folds objects.
 * Media terminal statuses are `ready`, `failed`, and `completed`. `newerBy` normalizes both
 * values through `readIsoDate` before `isIncomingNewer`: when both are missing or unparseable
 * the incoming value is accepted, while a missing or unparseable incoming value loses to a valid
 * previous value.
 */
export const compileWritePolicies = <TRow extends Record<string, unknown>>(groups: readonly WriteGroup[]) =>
  (previous: TRow, incoming: TRow, ctx: WriteCtx): TRow => {
    const effective: Record<string, unknown> = { ...previous, ...incoming };
    if (ctx.origin === 'replace') return effective as TRow;
    for (const group of groups) {
      const { policy } = group;
      if (policy === 'server') continue;
      if (policy === 'continuity') {
        for (const field of group.fields) if (field in incoming && incoming[field] == null) effective[field] = previous[field];
        continue;
      }
      if ('snapshot' in policy) {
        for (const field of group.fields) if (field in incoming) effective[field] = isNonArrayRecord(previous[field]) && isNonArrayRecord(incoming[field]) ? { ...previous[field], ...incoming[field] } : incoming[field];
        continue;
      }
      if ('media' in policy) {
        for (const field of group.fields) if (field in incoming) effective[field] = mergeMedia(previous[field], incoming[field], policy.media, ctx.origin);
        continue;
      }
      if (!appliesMonotonic(policy, ctx.origin)) continue;
      const changed = group.fields.some(field => field in incoming && !Object.is(incoming[field], previous[field]));
      if (!changed) continue;
      const spec = policy.monotonic;
      if ('nonEmpty' in spec) {
        for (const field of group.fields) if (field in incoming && !isPresent(incoming[field])) effective[field] = previous[field];
        continue;
      }
      const accepted = 'newerBy' in spec ? isIncomingNewerBy(spec.newerBy, incoming, previous) : isIncomingTupleNewer(spec.tuple, incoming, previous);
      if (!accepted) for (const field of group.fields) effective[field] = previous[field];
    }
    return effective as TRow;
  };
