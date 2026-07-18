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
export declare function mergeOptimisticMedia<TMedia extends MediaRecord>(optimistic: TMedia | null | undefined, server: TMedia | null | undefined, options?: MergeOptimisticMediaOptions<TMedia>): TMedia | null | undefined;
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
export declare function mergeOptimisticMedia(optimistic: unknown, server: unknown, options?: MergeOptimisticMediaOptions): unknown;
export {};
//# sourceMappingURL=optimisticMedia.d.ts.map