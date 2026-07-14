export type IngestDecl = { upsert?: unknown | unknown[]; destroy?: string | string[]; invalidate?: boolean };

export type IngestHandle = { apply(event: string, payload: unknown): IngestDecl | null };

/** Compile subscription payloads into apply-pipeline declarations. */
export const defineIngest = <TStored>(
  _model: unknown,
  handlers: Record<string, (payload: unknown) => IngestDecl | null>
): IngestHandle => ({
  apply: (event, payload) => handlers[event]?.(payload) ?? null
});
