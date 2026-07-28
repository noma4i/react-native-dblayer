/** Structural reference to a defined model; relation thunks resolve it after both models exist. */
export type ModelRef<TStored> = {
  modelId: string;
  find(id: string | null | undefined): TStored | undefined;
  all(): TStored[];
  where(where: Record<string, unknown>): TStored[];
};

/** Untyped stored row: arbitrary model fields without an id requirement. */
export type StoredRow = Record<string, unknown>;
/** Parent-touch producer: derives a parent patch from a child write, or null to skip. */
export type TouchFn = (child: StoredRow, parent: StoredRow) => StoredRow | null;

export type RelationDecl =
  | { kind: 'belongsTo'; model: ModelRef<StoredRow>; foreignKey: string; touch?: TouchFn; counterCache?: { field: string; filter?: (child: StoredRow) => boolean } }
  | { kind: 'hasMany'; model: ModelRef<StoredRow>; foreignKey: string; dependent?: 'destroy' }
  | { kind: 'hasOne'; model: ModelRef<StoredRow>; foreignKey: string; comparator?: (left: StoredRow, right: StoredRow) => number }
  | { kind: 'references'; model: ModelRef<StoredRow>; ids: (row: StoredRow) => ReadonlyArray<string | null | undefined> | string | null | undefined };

export type MembershipDelta = { scopeKey: string; append?: string[]; detach?: string[] };

export type AcceptedRow = { model: string; id: string; before: StoredRow | undefined; after: StoredRow; origin?: 'event' | 'replace' };
export type DestroyedRow = { model: string; id: string; before: StoredRow; origin?: 'replace' };

/** Model surface relation effects read and plan against. */
export type RelationHost = {
  relations(): Record<string, RelationDecl>;
  has(id: string): boolean;
  read(id: string): StoredRow | undefined;
  normalize(input: unknown): StoredRow | null;
  membershipForUpsert(before: StoredRow | undefined, after: StoredRow): MembershipDelta[];
  detachForDestroy(id: string): MembershipDelta[];
};

/** One planned parent-touch application with its pre-touch view for inverse plans. */
export type TouchEntry = { model: string; id: string; view: StoredRow; patch: StoredRow };

/** Address of one counter-cache field on a parent row. */
export type CounterRef = { model: string; id: string; field: string };

/** Snapshot reader used by relation planning to include earlier operations in the same envelope. */
export type RelationPlanReader = {
  read(model: string, id: string): StoredRow | undefined;
  rows(model: string): StoredRow[];
};
