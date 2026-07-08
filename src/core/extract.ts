import type { SyncContract } from '../types';
import { isRecord } from '../utils/normalizeHelpers';
import { mergeSyncContract } from '../utils/serverSync';
import { castNodes } from '../utils/typeBoundary';

/** Applies a resolved extract payload to application collections. */
export type DbExtractSink = (extractResult: unknown, source: string) => void;
/** Resolves a mutation extract spec with a server result. */
export type DbMutationExtractResolver = (extractSpec: unknown, result: unknown) => unknown;

type DbMutationExtractValue = unknown | unknown[] | null | undefined;

export type DbMutationExtractPresetSelector<TResult = unknown> = (result: TResult) => DbMutationExtractValue;

export type DbMutationExtractPresetEntry<TResult = unknown, TSinkKey extends string = string> = {
  /** Default reader used when the mutation extract preset is `true`. */
  read: string | ((result: TResult) => DbMutationExtractValue);
  /** Output key consumed by the extract sink. */
  sink: TSinkKey;
  /**
   * Whether the resolved value should be emitted as an array.
   * @default true
   */
  many?: boolean;
};

export type DbMutationExtractPresetTable<TResult = unknown, TSinkKey extends string = string> = Record<string, DbMutationExtractPresetEntry<TResult, TSinkKey>>;

export type DbExtractModelSink = {
  /** Apply server payloads with the source merge contract. */
  applyServerData: (items: unknown[], contract: SyncContract) => unknown;
};

export type DbExtractCustomSink = (payload: unknown[], source: string) => void;

export type DbExtractSinkTable = Record<string, DbExtractModelSink | DbExtractCustomSink>;

const defaultDbExtractSink: DbExtractSink = () => {};
const defaultDbMutationExtractResolver: DbMutationExtractResolver = extractSpec => extractSpec;

let currentDbExtractSink: DbExtractSink = defaultDbExtractSink;
let currentDbMutationExtractResolver: DbMutationExtractResolver = defaultDbMutationExtractResolver;

/** Set the sink used for query and mutation side-load payloads. */
export const setDbExtractSink = (sink: DbExtractSink): void => {
  currentDbExtractSink = sink;
};

/** Get the currently configured extract sink. */
export const getDbExtractSink = (): DbExtractSink => currentDbExtractSink;

/** Set the resolver used to turn mutation extract specs into payloads. */
export const setDbMutationExtractResolver = (resolver: DbMutationExtractResolver): void => {
  currentDbMutationExtractResolver = resolver;
};

/** Get the currently configured mutation extract resolver. */
export const getDbMutationExtractResolver = (): DbMutationExtractResolver => currentDbMutationExtractResolver;

/**
 * Normalize a mutation extract value into a compact array of non-null nodes.
 *
 * @param value Single node, node array, or nullish extract result.
 * @returns A node array with nullish entries removed.
 */
export const liftExtractNodes = (value: DbMutationExtractValue): unknown[] => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter(item => item != null);
  return [value];
};

const isEmptyExtractValue = (value: unknown): boolean => value == null || (Array.isArray(value) && value.length === 0);

/**
 * Merge a newly resolved preset value into an in-progress extract output under a shared sink key.
 *
 * Two or more mutation extract presets may target the same sink key (e.g. a `wallet` preset and a
 * `currentUser` preset both routing into a `currentUser` sink). Every combination is additive - no
 * combination silently drops a previously resolved value:
 *
 * - No existing value: the new value is stored as-is (array or single value, unchanged).
 * - Existing array + new array: concatenated (`existing.concat(value)`).
 * - Existing array + new single value: appended (`existing.concat([value])`).
 * - Existing single value + new array: prepended (`[existing].concat(value)`).
 * - Existing single value + new single value: promoted to a two-element array (`[existing, value]`),
 *   declaration order preserved. `createExtractSink` always runs `liftExtractNodes` on a sink's
 *   payload before dispatch, so a promoted array reaches a model sink exactly like any other array
 *   payload; a custom function sink receives the same lifted array as its `payload` argument.
 *
 * @param output Extract result accumulator, keyed by sink key.
 * @param key Sink key the resolved value should be merged into.
 * @param value Newly resolved preset value (array or single value).
 */
const appendExtractValue = (output: Record<string, unknown>, key: string, value: unknown): void => {
  const existing = output[key];
  if (existing === undefined) {
    output[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    output[key] = Array.isArray(value) ? existing.concat(value) : existing.concat([value]);
    return;
  }

  output[key] = Array.isArray(value) ? [existing].concat(value) : [existing, value];
};

const describePresetValue = (value: unknown): string => {
  if (typeof value === 'string') return `string "${value}"`;
  if (typeof value === 'symbol' || typeof value === 'function') return typeof value;
  try {
    return `${typeof value} ${JSON.stringify(value)}`;
  } catch {
    return typeof value;
  }
};

/**
 * Resolve one mutation extract preset entry's value for the current result.
 *
 * `false`/`undefined`/`null` are the only recognized "not requested" markers and resolve to `undefined`
 * (skipped by the caller's `isEmptyExtractValue` check) exactly as before. Any other value that is
 * neither `true` nor a selector function is a configuration mistake, not a legitimate skip - e.g.
 * `extract: { chat: 'true' }` or `{ chat: 1 }` - and throws instead of silently extracting nothing.
 */
const resolvePresetValue = <TResult>(
  preset: unknown,
  entry: DbMutationExtractPresetEntry<TResult>,
  result: TResult
): unknown | undefined => {
  const readValue = (): DbMutationExtractValue => (typeof entry.read === 'string' ? (result as Record<string, unknown> | null | undefined)?.[entry.read] : entry.read(result));

  if (preset === true) {
    return entry.many === false ? readValue() : liftExtractNodes(readValue());
  }

  if (typeof preset === 'function') {
    const selected = (preset as DbMutationExtractPresetSelector<TResult>)(result);
    return entry.many === false ? selected : liftExtractNodes(selected);
  }

  if (preset === false || preset == null) return undefined;

  throw new Error(`Invalid mutation extract preset for sink "${entry.sink}": expected \`true\` or a selector function, received ${describePresetValue(preset)}.`);
};

/**
 * Build a mutation extract resolver from a declarative preset table.
 * Boolean presets use the table reader; selector presets override the reader.
 */
export const createMutationExtractResolver =
  <TResult = unknown, TSinkKey extends string = string>(presetTable: DbMutationExtractPresetTable<TResult, TSinkKey>): DbMutationExtractResolver =>
  (extractSpec, result) => {
    if (!isRecord(extractSpec) || result == null) return undefined;

    const output: Record<string, unknown> = {};
    for (const presetKey of Object.keys(presetTable)) {
      const entry = presetTable[presetKey];
      const value = resolvePresetValue(extractSpec[presetKey], entry, result as TResult);
      if (isEmptyExtractValue(value)) continue;
      appendExtractValue(output, entry.sink, value);
    }

    return Object.keys(output).length > 0 ? output : undefined;
  };

const isModelSink = (sink: DbExtractModelSink | DbExtractCustomSink): sink is DbExtractModelSink => isRecord(sink) && typeof sink.applyServerData === 'function';

/**
 * Build an extract sink from a declarative sink table.
 * Sink keys run in declaration order.
 *
 * Every sink key's payload runs through `liftExtractNodes` before dispatch, so both branches see an
 * array regardless of whether the resolver produced a single value or an array (including the merged
 * multi-preset arrays `appendExtractValue` can now produce for a shared sink key): a model sink's
 * `applyServerData` always receives an array, and a custom function sink's `payload` argument is
 * always an array too.
 */
export const createExtractSink =
  (sinkTable: DbExtractSinkTable): DbExtractSink =>
  (extractResult, source) => {
    if (!isRecord(extractResult)) return;

    for (const key of Object.keys(sinkTable)) {
      const payload = extractResult[key];
      if (isEmptyExtractValue(payload)) continue;

      const sink = sinkTable[key];
      const nodes = liftExtractNodes(payload);
      if (nodes.length === 0) continue;
      if (isModelSink(sink)) {
        sink.applyServerData(castNodes(nodes), mergeSyncContract(source));
      } else {
        sink(nodes, source);
      }
    }
  };
