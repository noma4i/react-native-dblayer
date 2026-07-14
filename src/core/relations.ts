export type ModelRef<TStored> = {
  get(id: string | null | undefined): TStored | undefined;
};

export type RelationDecl =
  | { kind: 'belongsTo'; model: ModelRef<unknown>; foreignKey: string; touch?: (child: unknown, parent: unknown) => Record<string, unknown> | null; counterCache?: { field: string; filter?: (child: unknown) => boolean } }
  | { kind: 'hasMany'; model: ModelRef<unknown>; foreignKey: string; dependent?: 'destroy' }
  | { kind: 'hasOne'; model: ModelRef<unknown>; foreignKey: string; comparator?: (left: unknown, right: unknown) => number };

/** Declare an inverse parent relation and optional derived parent updates. */
export const belongsTo = <TChild, TParent>(
  model: ModelRef<TParent>,
  options: { foreignKey: keyof TChild & string; touch?: (child: TChild, parent: TParent) => Partial<TParent> | null; counterCache?: { field: keyof TParent & string; filter?: (child: TChild) => boolean } }
): RelationDecl => ({
  kind: 'belongsTo',
  model: model as ModelRef<unknown>,
  foreignKey: options.foreignKey,
  touch: options.touch as ((child: unknown, parent: unknown) => Record<string, unknown> | null) | undefined,
  counterCache: options.counterCache as { field: string; filter?: (child: unknown) => boolean } | undefined
});

/** Declare a direct child relation whose cascade authority is explicit destroy only. */
export const hasMany = <TParent, TChild>(
  model: ModelRef<TChild>,
  options: { foreignKey: keyof TChild & string; dependent?: 'destroy' }
): RelationDecl => ({ kind: 'hasMany', model: model as ModelRef<unknown>, foreignKey: options.foreignKey, dependent: options.dependent });

/** Declare a query-only single child relation. */
export const hasOne = <TParent, TChild>(
  model: ModelRef<TChild>,
  options: { foreignKey: keyof TChild & string; comparator?: (left: TChild, right: TChild) => number }
): RelationDecl => ({ kind: 'hasOne', model: model as ModelRef<unknown>, foreignKey: options.foreignKey, comparator: options.comparator as ((left: unknown, right: unknown) => number) | undefined });
