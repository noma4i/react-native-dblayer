import { isNonArrayRecord } from './normalizeHelpers';

type MediaRecord = Record<string, unknown>;

export type MergeOptimisticMediaOptions<TMedia extends MediaRecord = MediaRecord> = {
  /**
   * Dimension keys whose optimistic positive values should be kept when server dimensions are missing
   * or zero. Defaults to `width` and `height`.
   */
  dimensionKeys?: readonly [keyof TMedia & string, keyof TMedia & string];
  /** Source-like string fields that should fall back to optimistic non-empty values. */
  sourceKeys?: readonly (keyof TMedia & string)[];
};

const DEFAULT_DIMENSION_KEYS = ['width', 'height'] as const;

const isPositiveFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const isMissingDimension = (value: unknown): boolean => !isPositiveFiniteNumber(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Merge generic optimistic media continuity fields into a server media object.
 *
 * Positive optimistic dimensions are preserved when the server omits or zeroes configured dimension
 * keys, while real server dimensions win. Configured source keys prefer non-empty server strings and
 * otherwise keep non-empty optimistic strings. Nullish or non-object server values are returned as-is.
 *
 * @param optimistic Optimistic media-like record, or any nullish/non-object value.
 * @param server Server media-like record, or any nullish/non-object value.
 * @param options Dimension key pair and source-like string keys to merge.
 * @returns Server media with generic optimistic continuity fields applied, or the original server value.
 */
export function mergeOptimisticMedia<TMedia extends MediaRecord>(
  optimistic: TMedia | null | undefined,
  server: TMedia | null | undefined,
  options?: MergeOptimisticMediaOptions<TMedia>
): TMedia | null | undefined;
/**
 * Merge generic optimistic media continuity fields into a server media object.
 *
 * Positive optimistic dimensions are preserved when the server omits or zeroes configured dimension
 * keys, while real server dimensions win. Configured source keys prefer non-empty server strings and
 * otherwise keep non-empty optimistic strings. Nullish or non-object server values are returned as-is.
 *
 * @param optimistic Optimistic media-like record, or any nullish/non-object value.
 * @param server Server media-like record, or any nullish/non-object value.
 * @param options Dimension key pair and source-like string keys to merge.
 * @returns Server media with generic optimistic continuity fields applied, or the original server value.
 */
export function mergeOptimisticMedia(optimistic: unknown, server: unknown, options?: MergeOptimisticMediaOptions): unknown;
export function mergeOptimisticMedia(optimistic: unknown, server: unknown, options: MergeOptimisticMediaOptions = {}): unknown {
  if (!isNonArrayRecord(server)) return server;

  const optimisticRecord = isNonArrayRecord(optimistic) ? optimistic : undefined;
  const output: MediaRecord = { ...server };
  const dimensionKeys = options.dimensionKeys ?? DEFAULT_DIMENSION_KEYS;

  for (const key of dimensionKeys) {
    if (isMissingDimension(output[key]) && optimisticRecord && isPositiveFiniteNumber(optimisticRecord[key])) {
      output[key] = optimisticRecord[key];
    }
  }

  for (const key of options.sourceKeys ?? []) {
    if (!isNonEmptyString(output[key]) && optimisticRecord && isNonEmptyString(optimisticRecord[key])) {
      output[key] = optimisticRecord[key];
    }
  }

  return output;
}
