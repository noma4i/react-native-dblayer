export type MergeOptimisticFieldMerger = (optimisticValue: unknown, serverValue: unknown) => unknown;

export type MergeOptimisticSnapshotOptions<TOptimistic extends object, TServer extends object> = {
  fields?: Array<keyof (TOptimistic & TServer)>;
  mergers?: Partial<Record<keyof (TOptimistic & TServer), MergeOptimisticFieldMerger>>;
};

/**
 * Choose a committed field value while preserving useful optimistic placeholders.
 *
 * @param optimisticValue Existing optimistic field value.
 * @param serverValue Incoming server field value.
 * @returns The optimistic value when the server value is nullish or empty string, otherwise the server value.
 */
const resolveMergedField = (optimisticValue: unknown, serverValue: unknown): unknown => {
  if (serverValue === null || serverValue === undefined) {
    return optimisticValue;
  }

  if (typeof serverValue === 'string' && serverValue.length === 0) {
    return optimisticValue;
  }

  return serverValue;
};

const mergeAllFields = <TOptimistic extends object, TServer extends object>(
  optimistic: TOptimistic | null | undefined,
  server: TServer | null | undefined,
  fieldMergers?: Partial<Record<keyof (TOptimistic & TServer), MergeOptimisticFieldMerger>>
): TOptimistic | TServer | (TOptimistic & TServer) | null | undefined => {
  if (!optimistic) {
    return server;
  }

  if (!server) {
    return optimistic;
  }

  const optimisticRecord = optimistic as Record<string, unknown>;
  const serverRecord = server as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...optimisticRecord };
  const mergedKeys = new Set([...Object.keys(optimisticRecord), ...Object.keys(serverRecord)]);

  for (const key of mergedKeys) {
    const fieldMerger = fieldMergers?.[key as keyof (TOptimistic & TServer)];
    merged[key] = fieldMerger ? fieldMerger(optimisticRecord[key], serverRecord[key]) : resolveMergedField(optimisticRecord[key], serverRecord[key]);
  }

  return merged as TOptimistic & TServer;
};

/**
 * Merge an optimistic row snapshot with a committed server node.
 *
 * @param optimistic Optimistic row captured before commit.
 * @param server Server node returned by the mutation.
 * @param options Optional field allowlist and custom field mergers.
 * @returns The merged object, or whichever side exists when the other side is nullish.
 */
export const mergeOptimisticSnapshot = <TOptimistic extends object, TServer extends object>(
  optimistic: TOptimistic | null | undefined,
  server: TServer | null | undefined,
  options?: MergeOptimisticSnapshotOptions<TOptimistic, TServer>
): TOptimistic | TServer | (TOptimistic & TServer) | null | undefined => {
  if (!options?.fields) {
    return mergeAllFields(optimistic, server, options?.mergers);
  }

  if (!optimistic) {
    return server;
  }

  if (!server) {
    return optimistic;
  }

  const optimisticRecord = optimistic as Record<string, unknown>;
  const serverRecord = server as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...serverRecord };

  for (const key of options.fields) {
    const fieldKey = key as keyof (TOptimistic & TServer);
    const keyString = String(key);
    const fieldMerger = options.mergers?.[fieldKey];
    merged[keyString] = fieldMerger ? fieldMerger(optimisticRecord[keyString], serverRecord[keyString]) : resolveMergedField(optimisticRecord[keyString], serverRecord[keyString]);
  }

  return merged as TOptimistic & TServer;
};
