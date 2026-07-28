import type { OperationState } from './core.planes.operationState.types';
import type { DbSubscriptionEntry } from './subscription.types';
import type { ExtractSink } from './dsl.query.types';

export type IngestModel = {
  modelId: string;
  name?: string;
  find(id: string | null | undefined): unknown;
  insert(row: unknown): void;
  invalidate(scope?: unknown): void;
};

export type IngestDecl = {
  upsert?: unknown | unknown[];
  destroy?: string | string[];
  /** Invalidates only the query cache entries whose scope matches this object (exact or partial, per Model.invalidate semantics). */
  invalidate?: object;
  /** Full-model invalidation (every query prefix on the model) instead of a scoped one; use `invalidate` for the scoped case. */
  invalidateAll?: true;
  /** Echo guard: when this operation id already committed locally, the whole event is skipped. */
  operationId?: string | null;
  /** Cross-model sideloads applied in the SAME transaction as the event rows. */
  extract?: ExtractSink[];
};

export type ModelIngestTools = {
  /** Model that owns this fused ingest declaration. */
  model: IngestModel;
  /** Invalidate all queries registered for the owner model. */
  invalidate: () => void;
  /** Shared operation ledger for advanced custom handlers. */
  operations: OperationState;
  /** Models registered by `defineModel` name for multi-model custom handlers. */
  models: Record<string, IngestModel>;
};

export type ModelIngestEntry = {
  /** Subscription document passed to the configured transport. Required unless `handler` is used only for imperative delivery. */
  document?: DbSubscriptionEntry['query'];
  /** Declaration-return handler using the exact atomic `defineIngest` apply pipeline. */
  handler?: (payload: unknown) => IngestDecl | null;
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
