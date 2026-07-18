import type { JournalOp } from './apply/journal';

/** Structural reference to a defined model; relation thunks resolve it after both models exist. */
export type ModelRef<TStored> = {
  modelId: string;
  get(id: string | null | undefined): TStored | undefined;
  getAll(): TStored[];
  getWhere(where: Record<string, unknown>): TStored[];
};

type StoredRow = Record<string, unknown>;
type TouchFn = (child: StoredRow, parent: StoredRow) => StoredRow | null;

export type RelationDecl =
  | { kind: 'belongsTo'; model: ModelRef<StoredRow>; foreignKey: string; touch?: TouchFn; counterCache?: { field: string; filter?: (child: StoredRow) => boolean } }
  | { kind: 'hasMany'; model: ModelRef<StoredRow>; foreignKey: string; dependent?: 'destroy' }
  | { kind: 'hasOne'; model: ModelRef<StoredRow>; foreignKey: string; comparator?: (left: StoredRow, right: StoredRow) => number }
  | { kind: 'references'; model: ModelRef<StoredRow>; ids: (row: StoredRow) => ReadonlyArray<string | null | undefined> | string | null | undefined };

export type MembershipDelta = { scopeKey: string; append?: string[]; detach?: string[] };

/**
 * Declare an inverse parent relation (child -> parent) with optional derived parent updates from event data.
 * Resolved by `expandPlan`, which accumulates `touch` patches per parent (folding several children in one
 * plan) and `counterCache` increments/decrements, emitting them as extra `patch`/`counter` ops in the SAME
 * plan as the triggering event.
 *
 * @param model The parent model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.touch Derive a partial parent update from the child and current parent view; return `null`
 * to skip. Runs once per parent per plan even if several children touch it (last patch per field wins).
 * Only applies to EVENT plans - snapshot writes (queries, entity refreshes) are not expanded.
 * @param options.counterCache Increment `field` on the parent when a NEW child first references it, decrement
 * on child destroy (or on an uncommitted increment being cancelled within the same plan); `filter` restricts
 * which children count.
 * @returns A belongsTo relation declaration for a parent-model edge.
 */
export const belongsTo = <TChild, TParent>(
  model: ModelRef<TParent>,
  options: {
    foreignKey: keyof TChild & string;
    touch?: (child: TChild, parent: TParent) => Partial<TParent> | null;
    counterCache?: { field: keyof TParent & string; filter?: (child: TChild) => boolean };
  }
): RelationDecl => ({
  kind: 'belongsTo',
  model: model as ModelRef<StoredRow>,
  foreignKey: options.foreignKey,
  touch: options.touch as TouchFn | undefined,
  counterCache: options.counterCache as { field: string; filter?: (child: StoredRow) => boolean } | undefined
});

/**
 * Declare a direct child relation (parent -> children) whose cascade authority is explicit destroy only.
 * `expandPlan` reads children through `model.getWhere` (plus any same-plan overlay writes) so a cascade sees
 * children written earlier in the same plan.
 *
 * @param model The child model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.dependent `'destroy'` cascades a parent destroy to its live children in the same plan.
 * Omit for a query-only relation with no cascade. Optimistic destroy on the parent throws if this is set,
 * since a cascaded destroy cannot be rolled back.
 * @returns A hasMany relation declaration for a child-collection edge.
 */
export const hasMany = <TParent, TChild>(model: ModelRef<TChild>, options: { foreignKey: keyof TChild & string; dependent?: 'destroy' }): RelationDecl => ({
  kind: 'hasMany',
  model: model as ModelRef<StoredRow>,
  foreignKey: options.foreignKey,
  dependent: options.dependent
});

/**
 * Declare a query-only single child relation (parent -> one child), read through `model.related(id, name)`.
 * Not resolved by `expandPlan` - it has no write-time side effects, only a reactive query.
 *
 * @param model The child model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.comparator Pick the "one" child when several match; the lowest-sorting row wins. Omit to
 * use the first match in read order.
 * @returns A hasOne relation declaration for a single-child edge.
 */
export const hasOne = <TParent, TChild>(
  model: ModelRef<TChild>,
  options: { foreignKey: keyof TChild & string; comparator?: (left: TChild, right: TChild) => number }
): RelationDecl => ({
  kind: 'hasOne',
  model: model as ModelRef<StoredRow>,
  foreignKey: options.foreignKey,
  comparator: options.comparator as ((left: StoredRow, right: StoredRow) => number) | undefined
});

/**
 * Declare a GC-only reference edge: ids extracted from the row keep the referenced target-model rows alive
 * during garbage-collection sweeps. Not resolved by `expandPlan` - it has no write-time side effects, only
 * a GC liveness signal (see `referencesOf` in the model's GC host registration).
 *
 * @param model The referenced model.
 * @param options.ids Extract the referenced id(s) from the row; a single id, an array, or nullish (no reference).
 * @returns A references relation declaration for GC liveness edges.
 */
export const references = <TChild, TRef>(
  model: ModelRef<TRef>,
  options: { ids: (child: TChild) => ReadonlyArray<string | null | undefined> | string | null | undefined }
): RelationDecl => ({
  kind: 'references',
  model: model as ModelRef<StoredRow>,
  ids: options.ids as (row: StoredRow) => ReadonlyArray<string | null | undefined> | string | null | undefined
});

/**
 * Model-side capabilities the plan expander needs. Registered once per defineModel; the registry
 * survives resetRuntime the same way apply targets do - models keep working after the kill-switch.
 * Membership hooks derive declarative scope membership from ScopeSpec.by so event rows join and
 * leave their scopes in the SAME plan (same-tick visibility for optimistic/ingest rows).
 */
export type RelationHost = {
  relations(): Record<string, RelationDecl>;
  has(id: string): boolean;
  read(id: string): StoredRow | undefined;
  normalize(input: unknown): StoredRow | null;
  membershipForUpsert(row: StoredRow): MembershipDelta[];
  membershipForPatch(id: string, patch: StoredRow): MembershipDelta[];
  detachForDestroy(id: string): MembershipDelta[];
};

const hosts = new Map<string, RelationHost>();

export const registerRelationHost = (modelId: string, host: RelationHost): (() => void) => {
  hosts.set(modelId, host);
  return () => hosts.delete(modelId);
};

/** True when the model declares a hasMany dependent:'destroy' cascade - optimistic destroy cannot roll such a cascade back. */
export const hasDependentCascade = (modelId: string): boolean => {
  const host = hosts.get(modelId);
  if (!host) return false;
  return Object.values(host.relations()).some(relation => relation.kind === 'hasMany' && relation.dependent === 'destroy');
};

type TouchEntry = { model: string; id: string; view: StoredRow; patch: StoredRow };
type CounterRef = { model: string; id: string; field: string };

/**
 * Expand an EVENT plan with declared relation side effects (the Rails-callbacks analog):
 * counterCache increments for first-seen children, touch projections onto parents (emitted as
 * 'patch' ops in stored format, folded per parent so several children in one plan compose),
 * dependent destroy cascades, and declarative scope membership from ScopeSpec.by. Snapshot plans
 * (query pages / entity refreshes) must NOT be expanded - server snapshots already carry derived
 * state, so defineModel routes them through the verbatim apply path. A parent upserted by the same
 * plan is authoritative: its accumulated touch is cancelled and counter ops against it are
 * filtered out.
 */
export const expandPlan = (ops: JournalOp[]): JournalOp[] => {
  const queue: JournalOp[] = [...ops];
  const overlay = new Map<string, Map<string, StoredRow | null>>();
  const out: JournalOp[] = [];
  const authoritative = new Set<string>();
  const counted = new Map<string, CounterRef>();
  const destroyed = new Set<string>();
  const touched = new Set<string>();
  const touchViews = new Map<string, TouchEntry>();
  const membership = new Map<string, { model: string; scopeKey: string; append: Set<string>; detach: Set<string> }>();
  const explicitScopeDeltas: JournalOp[] = [];
  const overlayRead = (modelId: string, id: string): StoredRow | undefined => {
    const rows = overlay.get(modelId);
    if (rows?.has(id)) return rows.get(id) ?? undefined;
    return hosts.get(modelId)?.read(id);
  };
  const overlayWrite = (modelId: string, id: string, row: StoredRow | null): void => {
    const rows = overlay.get(modelId) ?? new Map<string, StoredRow | null>();
    rows.set(id, row);
    overlay.set(modelId, rows);
  };
  const accumulateMembership = (model: string, deltas: MembershipDelta[]): void => {
    for (const delta of deltas) {
      const key = `${model}:${delta.scopeKey}`;
      let entry = membership.get(key);
      if (!entry) {
        entry = { model, scopeKey: delta.scopeKey, append: new Set(), detach: new Set() };
        membership.set(key, entry);
      }
      for (const id of delta.append ?? []) {
        entry.append.add(id);
        entry.detach.delete(id);
      }
      for (const id of delta.detach ?? []) {
        entry.detach.add(id);
        entry.append.delete(id);
      }
    }
  };
  const detachAccumulatedMembership = (model: string, id: string): void => {
    for (const entry of membership.values()) {
      if (entry.model !== model || !entry.append.has(id)) continue;
      entry.append.delete(id);
      entry.detach.add(id);
    }
  };

  const parentIdOf = (row: StoredRow, foreignKey: string): string | null => {
    const value = row[foreignKey];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const countKeyOf = (modelId: string, childId: string, counter: CounterRef): string => `${modelId}:${childId}:${counter.model}:${counter.field}`;

  const accumulateTouch = (relation: Extract<RelationDecl, { kind: 'belongsTo' }>, child: StoredRow, parentId: string): void => {
    const parentKey = `${relation.model.modelId}:${parentId}`;
    if (!relation.touch || authoritative.has(parentKey) || touched.has(parentKey)) return;
    let entry = touchViews.get(parentKey);
    if (!entry) {
      const parent = relation.model.get(parentId);
      if (!parent) return;
      entry = { model: relation.model.modelId, id: parentId, view: { ...parent }, patch: {} };
      touchViews.set(parentKey, entry);
    }
    const patch = relation.touch(child, entry.view);
    if (patch) {
      Object.assign(entry.view, patch);
      Object.assign(entry.patch, patch);
    }
  };

  const upsertEffects = (modelId: string, host: RelationHost, row: StoredRow, existed: boolean): void => {
    const childId = String(row.id);
    for (const relation of Object.values(host.relations())) {
      if (relation.kind !== 'belongsTo') continue;
      const parentId = parentIdOf(row, relation.foreignKey);
      if (!parentId) continue;
      if (relation.counterCache && !existed && (relation.counterCache.filter?.(row) ?? true)) {
        const counter: CounterRef = { model: relation.model.modelId, id: parentId, field: relation.counterCache.field };
        const countKey = countKeyOf(modelId, childId, counter);
        if (!counted.has(countKey)) {
          counted.set(countKey, counter);
          queue.push({ kind: 'counter', model: counter.model, id: counter.id, field: counter.field, delta: 1 });
        }
      }
      accumulateTouch(relation, row, parentId);
    }
  };

  const patchEffects = (modelId: string, id: string, patch: StoredRow, current: StoredRow | undefined): void => {
    const host = hosts.get(modelId);
    if (!host) return;
    if (!current) return;
    const merged = { ...current, ...patch, id };
    for (const relation of Object.values(host.relations())) {
      if (relation.kind !== 'belongsTo') continue;
      const parentId = parentIdOf(merged, relation.foreignKey);
      if (parentId) accumulateTouch(relation, merged, parentId);
    }
  };

  const destroyEffects = (modelId: string, id: string, row: StoredRow | undefined): void => {
    const destroyKey = `${modelId}:${id}`;
    if (destroyed.has(destroyKey)) return;
    destroyed.add(destroyKey);
    const host = hosts.get(modelId);
    if (!host) return;
    for (const relation of Object.values(host.relations())) {
      if (relation.kind === 'belongsTo' && relation.counterCache) {
        const parentId = row ? parentIdOf(row, relation.foreignKey) : null;
        const counter: CounterRef | null = parentId ? { model: relation.model.modelId, id: parentId, field: relation.counterCache.field } : null;
        const pendingKey = counter ? countKeyOf(modelId, id, counter) : null;
        const pending = pendingKey ? counted.get(pendingKey) : undefined;
        if (pending && pendingKey) {
          counted.delete(pendingKey);
          queue.push({ kind: 'counter', model: pending.model, id: pending.id, field: pending.field, delta: -1 });
        } else if (row && counter && (relation.counterCache.filter?.(row) ?? true)) {
          queue.push({ kind: 'counter', model: counter.model, id: counter.id, field: counter.field, delta: -1 });
        }
      }
      if (relation.kind === 'hasMany' && relation.dependent === 'destroy') {
        const overlayRows = overlay.get(relation.model.modelId);
        const liveChildren = relation.model.getWhere({ [relation.foreignKey]: id }).filter(child => !overlayRows?.has(String(child.id)));
        const overlayChildren = [...(overlayRows?.values() ?? [])].filter((child): child is StoredRow => child !== null && child[relation.foreignKey] === id);
        const ids = [...liveChildren, ...overlayChildren]
          .map(child => String(child.id))
          .filter((childId, index, all) => all.indexOf(childId) === index)
          .filter(childId => !destroyed.has(`${relation.model.modelId}:${childId}`));
        if (ids.length > 0) queue.push({ kind: 'destroy', model: relation.model.modelId, ids });
      }
    }
  };

  while (queue.length > 0 || touchViews.size > 0) {
    while (queue.length > 0) {
      const op = queue.shift() as JournalOp;
      if (op.kind === 'scope-delta') {
        explicitScopeDeltas.push(op);
        continue;
      }
      out.push(op);
      if (op.kind === 'upsert') {
        const host = hosts.get(op.model);
        for (const raw of op.rows) {
          const row = host?.normalize(raw);
          if (!host || !row) continue;
          const existed = overlayRead(op.model, String(row.id)) !== undefined;
          upsertEffects(op.model, host, row, existed);
          accumulateMembership(op.model, host.membershipForUpsert(row));
          overlayWrite(op.model, String(row.id), { ...(overlayRead(op.model, String(row.id)) ?? {}), ...row });
          const key = `${op.model}:${String(row.id)}`;
          authoritative.add(key);
          touchViews.delete(key);
        }
      }
      if (op.kind === 'patch') {
        const current = overlayRead(op.model, op.id);
        patchEffects(op.model, op.id, op.patch, current);
        accumulateMembership(op.model, hosts.get(op.model)?.membershipForPatch(op.id, op.patch) ?? []);
        if (current) overlayWrite(op.model, op.id, { ...current, ...op.patch, id: op.id });
      }
      if (op.kind === 'destroy') {
        for (const id of op.ids) {
          accumulateMembership(op.model, hosts.get(op.model)?.detachForDestroy(id) ?? []);
          detachAccumulatedMembership(op.model, id);
          destroyEffects(op.model, id, overlayRead(op.model, id));
          overlayWrite(op.model, id, null);
        }
      }
    }
    const flush = [...touchViews.values()];
    touchViews.clear();
    for (const entry of flush) {
      const key = `${entry.model}:${entry.id}`;
      if (touched.has(key) || Object.keys(entry.patch).length === 0) continue;
      touched.add(key);
      queue.push({ kind: 'patch', model: entry.model, id: entry.id, patch: entry.patch });
    }
  }

  for (const entry of membership.values()) {
    if (entry.append.size === 0 && entry.detach.size === 0) continue;
    out.push({ kind: 'scope-delta', model: entry.model, scopeKey: entry.scopeKey, append: [...entry.append].map(id => ({ id })), detach: [...entry.detach] });
  }
  out.push(...explicitScopeDeltas);

  return out.filter(op => !(op.kind === 'counter' && authoritative.has(`${op.model}:${op.id}`)));
};
