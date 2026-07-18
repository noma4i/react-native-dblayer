import type { JournalOp } from '../core/apply/journal';
import { expandPlan } from '../core/relations';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState } from './configure';
import { getDbLogger } from '../core/logger';
import type { ExtractSink } from './defineQuery';
import { getDbSubscriptionEffect, type DbSubscriptionEntry } from '../core/subscriptionRuntime';

export type IngestDecl = {
  upsert?: unknown | unknown[];
  destroy?: string | string[];
  invalidate?: boolean;
  /** Echo guard: when this operation id already committed locally, the whole event is skipped. */
  operationId?: string | null;
  /** Cross-model sideloads applied in the SAME transaction as the event rows. */
  extract?: ExtractSink[];
};

export type IngestHandle = { apply(event: string, payload: unknown): IngestDecl | null };

type IngestModel = {
  modelId: string;
  name?: string;
  get(id: string | null | undefined): unknown;
  insertStored(row: unknown): void;
  invalidate(scope?: unknown): void;
  __planRows?(rows: unknown[]): JournalOp[];
};

const modelsByName = new Map<string, IngestModel>();

/** Register a model for the named-model lookup exposed to fused custom ingest handlers. */
export const registerIngestModel = (name: string, model: IngestModel): void => {
  modelsByName.set(name, model);
};

export type ModelIngestTools = {
  /** Model that owns this fused ingest declaration. */
  model: IngestModel;
  /** Invalidate all queries registered for the owner model. */
  invalidate: () => void;
  /** Shared operation ledger for advanced custom handlers. */
  operations: ReturnType<typeof getOperationState>;
  /** Models registered by `defineModel` name for multi-model custom handlers. */
  models: Record<string, IngestModel>;
};

export type ModelIngestEntry = {
  /** Subscription document passed to the configured transport. */
  document: DbSubscriptionEntry['query'];
  /** Transform the runtime payload before guard, effects, and apply. */
  payload?: (data: unknown) => unknown;
  /** Apply normalized rows, destroy an id, or run a custom model-aware handler. */
  apply?: 'upsert' | 'destroy' | ((payload: unknown, tools: ModelIngestTools) => void);
  /** Apply only to an already-present row, or use a custom acceptance predicate. */
  guard?: 'existing' | ((payload: unknown) => boolean);
  /** Return true to skip an own-echo subscription payload. */
  echoGuard?: (payload: unknown) => boolean;
  /** Trailing debounce delegated to the subscription runtime. */
  debounce?: DbSubscriptionEntry['debounce'];
  /** Invoke an injected named effect before or after apply. */
  effect?: { name: string; when: 'before' | 'after' };
};

const idOf = (payload: unknown): string | null => {
  if (typeof payload === 'string') return payload;
  const id = (payload as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
};

const reportModelIngestError = (model: IngestModel, event: string, error: unknown): void => {
  const reported = error instanceof Error ? error : new Error(String(error));
  try { getDbRuntimeConfig().defaults?.onSyncError?.(reported, { source: 'ingest', model: model.modelId, event }); } catch (observerError) { getDbLogger().error('defineIngest onSyncError failed', { error: observerError }); }
};

/**
 * Fuse model-owned subscription declarations with the existing ingest apply pipeline.
 *
 * @param model Model receiving mechanical rows and exposed to custom handlers.
 * @param entries Subscription event declarations keyed by their root-field name.
 * @returns Subscription entries accepted directly by `createDbSubscriptionRuntime`.
 */
export const defineModelIngest = (model: IngestModel, entries: Record<string, ModelIngestEntry>): DbSubscriptionEntry[] =>
  Object.entries(entries).map(([event, entry]) => ({
    key: event,
    query: entry.document,
    debounce: entry.debounce,
    onData: data => {
      const payload = entry.payload ? entry.payload(data) : data;
      try {
        if (entry.echoGuard?.(payload)) return;
        if (entry.guard === 'existing' && !model.get(idOf(payload))) return;
        if (typeof entry.guard === 'function' && !entry.guard(payload)) return;
        const runEffect = (): void => {
          if (!entry.effect) return;
          const effect = getDbSubscriptionEffect(entry.effect.name);
          if (!effect) throw new Error(`Unknown subscription effect ${entry.effect.name}`);
          effect(payload);
        };
        if (entry.effect?.when === 'before') runEffect();
        if (typeof entry.apply === 'function') {
          const tools: ModelIngestTools = {
            model,
            invalidate: () => model.invalidate(),
            operations: getOperationState(),
            get models() {
              return Object.fromEntries(modelsByName);
            }
          };
          entry.apply(payload, tools);
        } else if (entry.apply === 'destroy') {
          const id = idOf(payload);
          if (id) defineIngest(model, { [event]: () => ({ destroy: id }) }).apply(event, payload);
        } else {
          defineIngest(model, { [event]: next => ({ upsert: next }) }).apply(event, payload);
        }
        if (entry.effect?.when === 'after') runEffect();
      } catch (error) {
        reportModelIngestError(model, event, error);
      }
    }
  }));

/**
 * Compile a subscription event into ONE event plan: rows, destroys and extract sinks apply with
 * relation side effects (touch/counterCache/dependent) in a single epoch. Version arbitration for
 * stale events lives in the model's merge.shouldOverwrite gate - not here (one gate, no zoo).
 */
export const defineIngest = (model: IngestModel, handlers: Record<string, (payload: unknown) => IngestDecl | null>): IngestHandle => ({
  apply: (event, payload) => {
    try {
    const declaration = handlers[event]?.(payload) ?? null;
    if (!declaration) return null;
    if (declaration.operationId && getOperationState().hasCommitted(declaration.operationId)) return declaration;
    const rows = declaration.upsert == null ? [] : Array.isArray(declaration.upsert) ? declaration.upsert : [declaration.upsert];
    const ids = declaration.destroy == null ? [] : Array.isArray(declaration.destroy) ? declaration.destroy : [declaration.destroy];
    const ops: JournalOp[] = [];
    if (rows.length > 0) {
      ops.push(...(model.__planRows?.(rows).map(op => (op.kind === 'upsert' ? { ...op, origin: 'event' as const } : op)) ?? []));
    }
    if (ids.length > 0) ops.push({ kind: 'destroy', model: model.modelId, ids });
    for (const sink of declaration.extract ?? []) {
      ops.push(...(sink.into.__planRows?.(sink.rows).map(op => (op.kind === 'upsert' ? { ...op, origin: 'event' as const } : op)) ?? []));
    }
    if (ops.length > 0) getApplyRuntime().apply(expandPlan(ops));
    if (declaration.invalidate) model.invalidate();
    return declaration;
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try { getDbRuntimeConfig().defaults?.onSyncError?.(reported, { source: 'ingest', model: model.modelId, event }); } catch (observerError) { getDbLogger().error('defineIngest onSyncError failed', { error: observerError }); }
      return null;
    }
  }
});
