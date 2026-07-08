import type { SyncContract } from '../types';
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const liftExtractNodes = (value: DbMutationExtractValue): unknown[] => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter(item => item != null);
  return [value];
};

const isEmptyExtractValue = (value: unknown): boolean => value == null || (Array.isArray(value) && value.length === 0);

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

  output[key] = Array.isArray(value) ? [existing].concat(value) : value;
};

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

  return undefined;
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
