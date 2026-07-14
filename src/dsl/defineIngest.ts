export type IngestDecl = { upsert?: unknown | unknown[]; destroy?: string | string[]; invalidate?: boolean };

export type IngestHandle = { apply(event: string, payload: unknown): IngestDecl | null };

type IngestModel = {
  insertStored(row: { id: string }): void;
  destroyMany(ids: string[]): void;
  invalidate(scope?: unknown): void;
};

/** Compile a subscription declaration through the same public model write channel as mutations. */
export const defineIngest = <TStored>(
  model: IngestModel,
  handlers: Record<string, (payload: unknown) => IngestDecl | null>
): IngestHandle => ({
  apply: (event, payload) => {
    const declaration = handlers[event]?.(payload) ?? null;
    if (!declaration) return null;
    const rows = declaration.upsert == null ? [] : Array.isArray(declaration.upsert) ? declaration.upsert : [declaration.upsert];
    for (const row of rows) model.insertStored(row as { id: string });
    const ids = declaration.destroy == null ? [] : Array.isArray(declaration.destroy) ? declaration.destroy : [declaration.destroy];
    if (ids.length > 0) model.destroyMany(ids);
    if (declaration.invalidate) model.invalidate();
    return declaration;
  }
});
