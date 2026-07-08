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
export declare function mergeOptimisticMedia<TMedia extends MediaRecord>(optimistic: TMedia | null | undefined, server: TMedia | null | undefined, options?: MergeOptimisticMediaOptions<TMedia>): TMedia | null | undefined;
export declare function mergeOptimisticMedia(optimistic: unknown, server: unknown, options?: MergeOptimisticMediaOptions): unknown;
export {};
//# sourceMappingURL=optimisticMedia.d.ts.map