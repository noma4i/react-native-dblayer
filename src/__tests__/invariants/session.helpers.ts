import type { StoragePlane } from '../../core/planes/storagePlane';
import { collectGarbage } from '../../core/gc';
import { flushPersistence, getOperationState, replayJournal } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import { createContractScenario } from '../helpers/contractScenario';
import type { MemoryStorage } from '../helpers/memoryStorage';

export type SessionOperation =
  | { kind: 'pages'; model: string; scope: Record<string, unknown>; count: number; rowsPerPage: number }
  | { kind: 'ingestEvents'; model: string; count: number }
  | { kind: 'optimistic'; model: string; count: number; outcome: 'commit' | 'rollback' }
  | { kind: 'destroys'; model: string; count: number }
  | { kind: 'restart' };

export type SessionDriver = {
  pages(model: string, scope: Record<string, unknown>, count: number, rowsPerPage: number): void | Promise<void>;
  ingestEvents(model: string, count: number): void | Promise<void>;
  optimistic(model: string, count: number, outcome: 'commit' | 'rollback'): void | Promise<void>;
  destroys(model: string, count: number): void | Promise<void>;
  restart(): void | Promise<void>;
};

export type StoredModel = { modelId: string; getAll(): Array<unknown> };

/** Execute a deterministic profile script against one configured runtime driver. */
export const runSession = async (driver: SessionDriver, script: readonly SessionOperation[]): Promise<void> => {
  for (const operation of script) {
    if (operation.kind === 'pages') await driver.pages(operation.model, operation.scope, operation.count, operation.rowsPerPage);
    if (operation.kind === 'ingestEvents') await driver.ingestEvents(operation.model, operation.count);
    if (operation.kind === 'optimistic') await driver.optimistic(operation.model, operation.count, operation.outcome);
    if (operation.kind === 'destroys') await driver.destroys(operation.model, operation.count);
    if (operation.kind === 'restart') await driver.restart();
  }
};

export const storageKeyCount = (storage: StoragePlane, prefix = 'dbl:'): number => storage.keys(prefix).length;

export const storageByteSize = (storage: StoragePlane, prefix = 'dbl:'): number =>
  storage.keys(prefix).reduce((total, key) => total + (storage.get(key)?.length ?? 0), 0);

export const rowCount = (model: Pick<StoredModel, 'getAll'>): number => model.getAll().length;

export const scopeKeyCount = (storage: StoragePlane, model: Pick<StoredModel, 'modelId'>): number => storage.keys(`dbl:scope:${model.modelId}:`).length;

/** Deterministic mulberry32 pseudo-random generator for invariant replay. */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const seededOperations = (seed: number, count: number): SessionOperation[] => {
  const random = mulberry32(seed);
  const models = ['Alpha', 'Beta'] as const;
  const operations: SessionOperation[] = [];
  for (let index = 0; index < count; index += 1) {
    const model = models[Math.floor(random() * models.length)]!;
    const kind = Math.floor(random() * 7);
    if (kind === 0) operations.push({ kind: 'pages', model, scope: { bucket: String(Math.floor(random() * 3)) }, count: 1, rowsPerPage: 1 + Math.floor(random() * 3) });
    if (kind === 1) operations.push({ kind: 'pages', model, scope: { bucket: String(Math.floor(random() * 3)) }, count: 1, rowsPerPage: 1 + Math.floor(random() * 3) });
    if (kind === 2) operations.push({ kind: 'ingestEvents', model, count: 1 + Math.floor(random() * 3) });
    if (kind === 3) operations.push({ kind: 'optimistic', model, count: 1, outcome: 'commit' });
    if (kind === 4) operations.push({ kind: 'optimistic', model, count: 1, outcome: 'rollback' });
    if (kind === 5) operations.push({ kind: 'destroys', model, count: 1 + Math.floor(random() * 2) });
    if (kind === 6) operations.push({ kind: 'restart' });
  }
  return operations;
};

export const withSeedContext = (seed: number, operations: readonly unknown[], error: unknown): Error =>
  new Error(`seed=${seed} operations=${JSON.stringify(operations)} error=${error instanceof Error ? error.message : String(error)}`);

export const RETENTION_MAX_ROWS = 24;

type InvariantModel = ReturnType<typeof defineModel>;

export type InvariantFixture = {
  storage: MemoryStorage;
  models: Record<'Alpha' | 'Beta', InvariantModel>;
  driver: SessionDriver;
  flushAndCollect(): void;
};

/** Shared two-model runtime fixture for budget, lifecycle, steady-state, and sequence invariants. */
export const createInvariantFixture = (): InvariantFixture => {
  const storage = createContractScenario({ persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } });
  const createModel = (id: string) =>
    defineModel({
      id,
      name: id,
      fields: { bucket: f.str(), value: f.num() },
      scopes: { feed: scope({ by: { bucket: 'bucket' }, sort: 'server-order', retention: { maxRows: RETENTION_MAX_ROWS } }) }
    });
  const models = { Alpha: createModel('InvariantAlpha'), Beta: createModel('InvariantBeta') };
  const modelFor = (name: string): InvariantModel => models[name as keyof typeof models];
  const row = (id: string, bucket: string) => ({ id, bucket, value: id.length + bucket.length });
  const driver: SessionDriver = {
    pages: (model, scopeValue, count, rowsPerPage) => {
      const target = modelFor(model);
      for (let page = 0; page < count; page += 1) {
        const bucket = String(scopeValue.bucket ?? '0');
        const rows = Array.from({ length: rowsPerPage }, (_, index) => row(`${model}:page:${bucket}:${index}`, bucket));
        target.scopes.feed.__apply?.(scopeValue, rows, 'complete', { resetOrder: true });
      }
    },
    ingestEvents: (model, count) => {
      const target = modelFor(model);
      for (let index = 0; index < count; index += 1) {
        const bucket = String(index % 3);
        target.insertStored(row(`${model}:page:${bucket}:${index % RETENTION_MAX_ROWS}`, bucket));
      }
    },
    optimistic: (model, count, outcome) => {
      const target = modelFor(model);
      for (let index = 0; index < count; index += 1) {
        const optimisticRow = row(`${model}:optimistic:${index}`, '0');
        const operationId = `${model}:operation:${index}`;
        target.insertStored(optimisticRow);
        getOperationState().begin({ operationId, model: target.modelId, tempIds: [optimisticRow.id], intent: 'insert', idempotencyKey: operationId, createdAt: Date.now() });
        if (outcome === 'commit') getOperationState().close(operationId, 'committed');
        else {
          target.destroy(optimisticRow.id);
          getOperationState().close(operationId, 'rolledback');
        }
      }
    },
    destroys: (model, count) => {
      const target = modelFor(model);
      for (const rowToDestroy of target.getAll().slice(0, count)) target.destroy(String((rowToDestroy as { id: string }).id));
    },
    restart: () => {
      flushPersistence();
      replayJournal();
      collectGarbage();
    }
  };
  return { storage, models, driver, flushAndCollect: () => { flushPersistence(); collectGarbage(); } };
};
