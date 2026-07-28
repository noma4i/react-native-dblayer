import type { ModelFieldSpecs } from './db.types';
export type FieldMode = 'required' | 'nullable' | 'optional' | 'optionalNullable';

export type FieldDefault<TOut> = TOut | (() => TOut);

export type NullableMode<TMode extends FieldMode> = TMode extends 'optional' | 'optionalNullable' ? 'optionalNullable' : 'nullable';

export type OptionalMode<TMode extends FieldMode> = TMode extends 'nullable' | 'optionalNullable' ? 'optionalNullable' : 'optional';

export interface FieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> {
  /** Stable field-builder identity used by persistence compatibility checks. */
  readonly kind: string;
  /** Read this field from a full input object and object key. */
  read: (input: TInput, key: string) => TOut | null | undefined;
  /** Read this field from an already-selected raw value. */
  readValue: FieldValueReader<TOut>;
  /** Reader derives the value from a whole input object; readValue is not idempotent on stored values, so key coercion must not re-apply it. */
  derived?: boolean;
  /** Current presence mode used by normalize and build. */
  mode: TMode;
  /** Whether this field supplies a build-time default. */
  readonly hasDefault: boolean;
  /** Factory-time default used by build when the caller omits this key. */
  factoryDefault?: FieldDefault<TOut>;
  /**
   * Preserve explicit `null` during normalize while still skipping `undefined`.
   *
   * build fills omitted nullable fields with `null` unless `.default(...)` is present.
   *
   * @returns A field spec whose stored type includes `null`.
   */
  nullable: () => FieldSpec<TInput, TOut, NullableMode<TMode>, THasDefault>;
  /**
   * Allow normalize and build to omit this key.
   *
   * Optional fields are not required by build and receive no implicit value.
   *
   * @returns A field spec whose stored key is optional.
   */
  optional: () => FieldSpec<TInput, TOut, OptionalMode<TMode>, THasDefault>;
  /**
   * Convert missing or undefined normalize input to `null`.
   *
   * build also fills omitted nullable fields with `null` unless `.default(...)` is present.
   *
   * @returns A nullable field spec that defaults missing normalize input to `null`.
   */
  nullDefault: () => FieldSpec<TInput, TOut, 'nullable', THasDefault>;
  /**
   * Provide a build-only default for omitted fields.
   *
   * normalize still uses the reader/nullability rules; lazy defaults run for each build call.
   *
   * @param value Stored value or factory used when build omits the key.
   * @returns A field spec that no longer requires this key in build input.
   */
  default: (value: FieldDefault<TOut>) => FieldSpec<TInput, TOut, TMode, true>;
  /**
   * Read this field from a selector result instead of `input[key]`.
   *
   * The selected value is passed to the same field reader and nullability rules.
   *
   * @param selector Source selector that receives the full input object.
   * @returns A field spec with the same output rules and a new input type.
   */
  from: <TNextInput = TInput>(selector: (input: TNextInput) => unknown) => FieldSpec<TNextInput, TOut, TMode, THasDefault>;
  /**
   * Read this field from an own property on the input or a source-selected object.
   *
   * Missing keys, nullish sources, and non-object sources resolve to `undefined`; the field reader,
   * nullability, and defaults then apply exactly as they do for `.from(...)`.
   *
   * @param key Source object key to read.
   * @param source Optional selector that receives the full input object before the key read.
   * @returns A field spec with the same output rules and a new input type.
   */
  fromKey: <TNextInput = TInput>(key: string, source?: (input: TNextInput) => unknown) => FieldSpec<TNextInput, TOut, TMode, THasDefault>;
}

export interface EmptyDefaultFieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> extends FieldSpec<TInput, TOut, TMode, THasDefault> {
  /**
   * Provide a build-only zero-state default for nested object fields.
   *
   * The default is produced by reading the object shape from `{}` and is recomputed per build call.
   *
   * @returns An object field spec that no longer requires this key in build input.
   */
  emptyDefault: () => EmptyDefaultFieldSpec<TInput, TOut, TMode, true>;
}

/** Read a selected raw value into a stored field value. */
export type FieldValueReader<TOut> = (value: unknown) => TOut | null | undefined;

/** Field source selector: picks the raw input value for one declared field key. */
export type FieldSourceSelector<TInput> = (input: TInput, key: string) => unknown;

/** Internal construction options behind every `f.*` field spec. */
export type FieldSpecOptions<TInput, TOut, TMode extends FieldMode> = {
  kind: string;
  mode: TMode;
  selectSource: FieldSourceSelector<TInput>;
  readValue: FieldValueReader<TOut>;
  readNullableValue: FieldValueReader<TOut>;
  derived?: boolean;
  defaultNull: boolean;
  factoryDefault?: FieldDefault<TOut>;
};

/** Type-only bridge onto the runtime field-spec module (its sparse-read symbol key). */
type FieldSpecModule = typeof import('../schema/fieldSpec');
/** A field spec that also carries the sparse-read entry keyed by the runtime symbol. */
export type SparseModelField = ModelFieldSpecs[string] & { [K in FieldSpecModule['fieldSpecSparseRead']]: (value: unknown, fieldKey: string) => unknown };
