import { act } from 'react-test-renderer';
import { configureDb, defineModel, f } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted, setupSpecRuntime } from '../helpers/harness';

type TestRow = { id: string; name: string; status: string; score: number };

const document = { kind: 'Document', definitions: [] } as never;

const createPointModel = () =>
  defineModel({
    id: 'SpecRerenderPointReads',
    name: 'SpecRerenderPointReads',
    fields: {
      name: f.str(),
      status: f.str(),
      score: f.num()
    }
  });

const createUnrelatedModel = () =>
  defineModel({
    id: 'SpecRerenderPointReadsUnrelated',
    name: 'SpecRerenderPointReadsUnrelated',
    fields: { value: f.str() }
  });

const seedRows = (model: ReturnType<typeof createPointModel>, row7Status: string = 'b', row7Score = 70): void => {
  model.insertStoredMany(
    Array.from({ length: 20 }, (_, index) => {
      const status = index === 5 ? 'b' : index === 7 ? row7Status : index % 2 === 0 ? 'a' : 'b';
      const score = index === 7 ? row7Score : index;
      return {
        id: String(index),
        name: `name-${index}`,
        status,
        score
      } as TestRow;
    })
  );
};

type PointReaders = {
  row5: ReturnType<typeof renderCounted<TestRow | undefined>>;
  row5Projection: ReturnType<typeof renderCounted<{ name: string } | undefined>>;
  row5StatusRender: ReturnType<typeof renderCounted<TestRow | undefined>>;
  field5Name: ReturnType<typeof renderCounted<string | undefined>>;
  byIds: ReturnType<typeof renderCounted<ByIdResult>>;
  firstA: ReturnType<typeof renderCounted<TestRow | undefined>>;
  whereA: ReturnType<typeof renderCounted<TestRow[]>>;
  count: ReturnType<typeof renderCounted<number>>;
  pending5: ReturnType<typeof renderCounted<boolean>>;
};

const mountReaders = (rows: ReturnType<typeof createPointModel>): PointReaders => ({
  row5: renderCounted(() => rows.use.row('5')),
  row5Projection: renderCounted(() => rows.use.row('5', { select: row => ({ name: row.name }) })),
  row5StatusRender: renderCounted(() => rows.use.row('5', { renderKeys: ['status'] })),
  field5Name: renderCounted(() => rows.use.field('5', 'name')),
  byIds: renderCounted(() => rows.use.byIds(['4', '5', '7'])),
  firstA: renderCounted(() => rows.use.first({ status: 'a' })),
  whereA: renderCounted(() => rows.use.where({ status: 'a' }).orderBy('score').rows()),
  count: renderCounted(() => rows.use.count()),
  pending5: renderCounted(() => rows.use.pending('5'))
});

const capture = (readers: PointReaders) => ({
  row5: readers.row5.renders(),
  row5Projection: readers.row5Projection.renders(),
  row5StatusRender: readers.row5StatusRender.renders(),
  field5Name: readers.field5Name.renders(),
  byIds: readers.byIds.renders(),
  firstA: readers.firstA.renders(),
  whereA: readers.whereA.renders(),
  count: readers.count.renders(),
  pending5: readers.pending5.renders()
});

type MatrixExpectations = {
  row5: number;
  row5Projection: number;
  row5StatusRender: number;
  field5Name: number;
  byIds: number;
  firstA: number;
  whereA: number;
  count: number;
  pending5: number;
};

const expectReaderDeltas = (before: ReturnType<typeof capture>, after: ReturnType<typeof capture>, expected: MatrixExpectations): void => {
  expect(after.row5 - before.row5).toBe(expected.row5);
  expect(after.row5Projection - before.row5Projection).toBe(expected.row5Projection);
  expect(after.row5StatusRender - before.row5StatusRender).toBe(expected.row5StatusRender);
  expect(after.field5Name - before.field5Name).toBe(expected.field5Name);
  expect(after.byIds - before.byIds).toBe(expected.byIds);
  expect(after.firstA - before.firstA).toBe(expected.firstA);
  expect(after.whereA - before.whereA).toBe(expected.whereA);
  expect(after.count - before.count).toBe(expected.count);
  expect(after.pending5 - before.pending5).toBe(expected.pending5);
};

function deferredMutation<TData>() {
  let resolve!: (value: TData) => void;
  const promise = new Promise<TData>(nextResolve => {
    resolve = nextResolve;
  });
  const transport = createMockTransport({
    mutation: async <TData,>() => ({
      data: (await promise) as TData
    })
  });
  return { transport, resolve, promise: promise as Promise<TData> };
};

type ByIdResult = { rows: TestRow[]; byId: ReadonlyMap<string, TestRow> };

describe('rerender matrix point reads', () => {
  it('patches one row name with only the narrowest reader deltas', () => {
    setupSpecRuntime();
    const rows = createPointModel();
    seedRows(rows);
    const readers = mountReaders(rows);
    const before = capture(readers);

    act(() => {
      rows.patch('5', { name: 'name-5-updated' });
    });

    const after = capture(readers);
    expectReaderDeltas(before, after, {
      row5: 1,
      row5Projection: 1,
      row5StatusRender: 0,
      field5Name: 1,
      byIds: 1,
      firstA: 0,
      whereA: 0,
      count: 0,
      pending5: 0
    });
    readers.row5.unmount();
    readers.row5Projection.unmount();
    readers.row5StatusRender.unmount();
    readers.field5Name.unmount();
    readers.byIds.unmount();
    readers.firstA.unmount();
    readers.whereA.unmount();
    readers.count.unmount();
    readers.pending5.unmount();
  });

  it('patches one row score with row5 row and byIds readers only', () => {
    setupSpecRuntime();
    const rows = createPointModel();
    seedRows(rows);
    const readers = mountReaders(rows);
    const before = capture(readers);

    act(() => {
      rows.patch('5', { score: 105 });
    });

    const after = capture(readers);
    expectReaderDeltas(before, after, {
      row5: 1,
      row5Projection: 0,
      row5StatusRender: 0,
      field5Name: 0,
      byIds: 1,
      firstA: 0,
      whereA: 0,
      count: 0,
      pending5: 0
    });
    readers.row5.unmount();
    readers.row5Projection.unmount();
    readers.row5StatusRender.unmount();
    readers.field5Name.unmount();
    readers.byIds.unmount();
    readers.firstA.unmount();
    readers.whereA.unmount();
    readers.count.unmount();
    readers.pending5.unmount();
  });

  it('patches row7 that matches where with where-order reader touch only', () => {
    setupSpecRuntime();
    const rows = createPointModel();
    seedRows(rows, 'a', 70);
    const readers = mountReaders(rows);
    const before = capture(readers);

    act(() => {
      rows.patch('7', { score: 99 });
    });

    const after = capture(readers);
    expectReaderDeltas(before, after, {
      row5: 0,
      row5Projection: 0,
      row5StatusRender: 0,
      field5Name: 0,
      byIds: 1,
      firstA: 0,
      whereA: 1,
      count: 0,
      pending5: 0
    });
    readers.row5.unmount();
    readers.row5Projection.unmount();
    readers.row5StatusRender.unmount();
    readers.field5Name.unmount();
    readers.byIds.unmount();
    readers.firstA.unmount();
    readers.whereA.unmount();
    readers.count.unmount();
    readers.pending5.unmount();
  });

  it('patches row7 that is not matched by where with no where-order reader rerender', () => {
    setupSpecRuntime();
    const rows = createPointModel();
    seedRows(rows, 'b', 70);
    const readers = mountReaders(rows);
    const before = capture(readers);

    act(() => {
      rows.patch('7', { score: 99 });
    });

    const after = capture(readers);
    expectReaderDeltas(before, after, {
      row5: 0,
      row5Projection: 0,
      row5StatusRender: 0,
      field5Name: 0,
      byIds: 1,
      firstA: 0,
      whereA: 0,
      count: 0,
      pending5: 0
    });
    readers.row5.unmount();
    readers.row5Projection.unmount();
    readers.row5StatusRender.unmount();
    readers.field5Name.unmount();
    readers.byIds.unmount();
    readers.firstA.unmount();
    readers.whereA.unmount();
    readers.count.unmount();
    readers.pending5.unmount();
  });

  it('inserts a status b row with only count reader rerender', () => {
    setupSpecRuntime();
    const rows = createPointModel();
    seedRows(rows);
    const readers = mountReaders(rows);
    const before = capture(readers);

    act(() => {
      rows.insertStored({ id: '20', name: 'name-20', status: 'b', score: 20 });
    });

    const after = capture(readers);
    expectReaderDeltas(before, after, {
      row5: 0,
      row5Projection: 0,
      row5StatusRender: 0,
      field5Name: 0,
      byIds: 0,
      firstA: 0,
      whereA: 0,
      count: 1,
      pending5: 0
    });
    readers.row5.unmount();
    readers.row5Projection.unmount();
    readers.row5StatusRender.unmount();
    readers.field5Name.unmount();
    readers.byIds.unmount();
    readers.firstA.unmount();
    readers.whereA.unmount();
    readers.count.unmount();
    readers.pending5.unmount();
  });

  it('destroys a byIds row with byIds and count readers rerender only', () => {
    setupSpecRuntime();
    const rows = createPointModel();
    seedRows(rows);
    const readers = mountReaders(rows);
    const before = capture(readers);

    act(() => {
      rows.destroy('7');
    });

    const after = capture(readers);
    expectReaderDeltas(before, after, {
      row5: 0,
      row5Projection: 0,
      row5StatusRender: 0,
      field5Name: 0,
      byIds: 1,
      firstA: 0,
      whereA: 0,
      count: 1,
      pending5: 0
    });
    readers.row5.unmount();
    readers.row5Projection.unmount();
    readers.row5StatusRender.unmount();
    readers.field5Name.unmount();
    readers.byIds.unmount();
    readers.firstA.unmount();
    readers.whereA.unmount();
    readers.count.unmount();
    readers.pending5.unmount();
  });

  it('is stable under idempotent patch of row5', () => {
    setupSpecRuntime();
    const rows = createPointModel();
    seedRows(rows);
    const readers = mountReaders(rows);
    const before = capture(readers);

    act(() => {
      rows.patch('5', { name: 'name-5', status: 'b', score: 5 });
    });

    const after = capture(readers);
    expectReaderDeltas(before, after, {
      row5: 0,
      row5Projection: 0,
      row5StatusRender: 0,
      field5Name: 0,
      byIds: 0,
      firstA: 0,
      whereA: 0,
      count: 0,
      pending5: 0
    });
    readers.row5.unmount();
    readers.row5Projection.unmount();
    readers.row5StatusRender.unmount();
    readers.field5Name.unmount();
    readers.byIds.unmount();
    readers.firstA.unmount();
    readers.whereA.unmount();
    readers.count.unmount();
    readers.pending5.unmount();
  });

  it('tracks optimistic row mutation pending state and row-level readers', async () => {
    const deferred = deferredMutation<{ save: TestRow }>();
    const { transport, resolve, promise } = deferred;
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createPointModel();
    rows.insertStored({ id: '5', name: 'name-5', status: 'b', score: 5 });
    const mutation = rows.mutation<{ save: TestRow }, { id: string; name: string }, TestRow, TestRow>('rename', {
      document,
      result: 'save',
      optimistic: {
        method: 'patch',
        model: rows,
        selectId: input => input.id,
        selectPatch: input => ({ name: input.name })
      },
      extract: ({ data }) => []
    });
    const readers = mountReaders(rows);
    const before = capture(readers);

    let run!: Promise<{ save: TestRow } | null>;
    act(() => {
      run = mutation.run({ id: '5', name: 'name-5-committed' });
    });

    expect(readers.pending5.result()).toBe(true);
    resolve({ save: { id: '5', name: 'name-5-committed', status: 'b', score: 5 } });

    await act(async () => {
      await run;
      await promise;
    });

    const after = capture(readers);
    expect(readers.pending5.result()).toBe(false);
    expect(after.row5StatusRender - before.row5StatusRender).toBe(0);
    expect(after.row5Projection - before.row5Projection).toBe(1);
    readers.row5.unmount();
    readers.row5Projection.unmount();
    readers.row5StatusRender.unmount();
    readers.field5Name.unmount();
    readers.byIds.unmount();
    readers.firstA.unmount();
    readers.whereA.unmount();
    readers.count.unmount();
    readers.pending5.unmount();
  });

  it('isolates all point readers from writes in unrelated model', () => {
    setupSpecRuntime();
    const rows = createPointModel();
    const noise = createUnrelatedModel();
    seedRows(rows);
    noise.insertStored({ id: '0', value: 'noise' });
    const readers = mountReaders(rows);
    const before = capture(readers);

    act(() => {
      noise.patch('0', { value: 'noise-updated' });
    });

    const after = capture(readers);
    expectReaderDeltas(before, after, {
      row5: 0,
      row5Projection: 0,
      row5StatusRender: 0,
      field5Name: 0,
      byIds: 0,
      firstA: 0,
      whereA: 0,
      count: 0,
      pending5: 0
    });
    readers.row5.unmount();
    readers.row5Projection.unmount();
    readers.row5StatusRender.unmount();
    readers.field5Name.unmount();
    readers.byIds.unmount();
    readers.firstA.unmount();
    readers.whereA.unmount();
    readers.count.unmount();
    readers.pending5.unmount();
  });
});
