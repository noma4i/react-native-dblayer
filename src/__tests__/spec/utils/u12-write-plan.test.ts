import {
  configureDb,
  createWritePlanCollector,
  defineModel,
  defineShape,
  f,
  runWritePlanInvalidations,
  stampCausalRevision
} from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; value: string };

const RowSchema = defineShape<Row>()({ value: f.str() });

describe('write plan validation', () => {
  it('stamps only entity writes with the causal base revision', () => {
    expect(
      stampCausalRevision(
        [
          { kind: 'upsert', model: 'Rows', rows: [{ id: 'row-1' }] },
          { kind: 'patch', model: 'Rows', id: 'row-1', patch: { value: 'next' } },
          { kind: 'destroy', model: 'Rows', ids: ['row-2'] },
          { kind: 'scope-delta', model: 'Rows', scopeKey: 'scope', append: [], detach: [] }
        ],
        7
      )
    ).toEqual([
      { kind: 'upsert', model: 'Rows', rows: [{ id: 'row-1' }], baseRevision: 7 },
      { kind: 'patch', model: 'Rows', id: 'row-1', patch: { value: 'next' }, baseRevision: 7 },
      { kind: 'destroy', model: 'Rows', ids: ['row-2'], baseRevision: 7 },
      { kind: 'scope-delta', model: 'Rows', scopeKey: 'scope', append: [], detach: [] }
    ]);
  });

  it('fences invalidations before, between, after, and through callback errors', () => {
    const onError = jest.fn();
    expect(runWritePlanInvalidations([], () => false, onError)).toBe(false);

    let checks = 0;
    const first = jest.fn();
    const second = jest.fn();
    expect(
      runWritePlanInvalidations(
        [{ invalidate: first }, { invalidate: second }],
        () => ++checks < 4,
        onError
      )
    ).toBe(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    const failure = new Error('invalidate failed');
    expect(
      runWritePlanInvalidations(
        [{ invalidate: () => { throw failure; } }],
        () => true,
        onError
      )
    ).toBe(true);
    expect(onError).toHaveBeenCalledWith(failure);

    checks = 0;
    expect(runWritePlanInvalidations([], () => ++checks === 1, onError)).toBe(false);
  });

  it('rejects malformed targets and intents before compiling writes', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Model = defineModel('SpecWritePlanValidation', { schema: RowSchema });

    const invalidModel = createWritePlanCollector();
    invalidModel.plan.upsert(null as never, { id: 'row-1', value: 'value' } as never);
    expect(() => invalidModel.compile()).toThrow('requires a valid model target');

    const invalidId = createWritePlanCollector();
    invalidId.plan.update(Model, '', { value: 'value' });
    expect(() => invalidId.compile()).toThrow('requires a non-empty string id');

    const invalidPatch = createWritePlanCollector();
    invalidPatch.plan.update(Model, 'row-1', [] as never);
    expect(() => invalidPatch.compile()).toThrow('requires a plain object patch');

    const undefinedPatch = createWritePlanCollector();
    undefinedPatch.plan.update(Model, 'row-1', { value: undefined });
    expect(() => undefinedPatch.compile()).toThrow('does not accept undefined');

    const invalidDestroy = createWritePlanCollector();
    invalidDestroy.plan.destroy(Model, ['row-1', '']);
    expect(() => invalidDestroy.compile()).toThrow('requires non-empty string ids');

    const invalidInvalidation = createWritePlanCollector();
    invalidInvalidation.plan.invalidate(null as never);
    expect(() => invalidInvalidation.compile()).toThrow('requires an invalidation target');
  });

  it('reuses validated handles and preserves event origin', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Model = defineModel('SpecWritePlanReuse', { schema: RowSchema });
    const collector = createWritePlanCollector({ origin: 'event' });
    collector.plan.upsert(Model, { id: 'row-1', value: 'first' });
    collector.plan.upsert(Model, [{ id: 'row-2', value: 'second' }]);
    collector.plan.update(Model, 'row-1', { value: 'updated' });
    collector.plan.destroy(Model, ['row-2']);
    const invalidate = Object.assign(() => undefined, { invalidate: jest.fn() });
    collector.plan.invalidate(invalidate);
    collector.plan.invalidate(invalidate);

    const compiled = collector.compile();

    expect(compiled.writeOps).toEqual([
      { kind: 'upsert', model: Model.key, rows: [{ id: 'row-1', value: 'first' }], origin: 'event' },
      { kind: 'upsert', model: Model.key, rows: [{ id: 'row-2', value: 'second' }], origin: 'event' },
      { kind: 'patch', model: Model.key, id: 'row-1', patch: { value: 'updated' } },
      { kind: 'destroy', model: Model.key, ids: ['row-2'] }
    ]);
    expect(compiled.invalidations).toEqual([invalidate]);
  });
});
