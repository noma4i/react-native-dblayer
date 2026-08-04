import { act } from 'react';
import { createCommitEnvelope, configureDb, defineModel, defineShape, f, getApplyRuntime, getApplyTarget, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type Row = { id: string; chatId: string; seq: number };

const RowSchema = defineShape<Row>()({ chatId: f.str(), seq: f.num() });
const compareNewestFirst = (left: Row, right: Row): number => right.seq - left.seq;

const defineRows = (key: string) =>
  defineModel(key, {
    schema: RowSchema,
    relations: () => ({
      thread: { by: { chatId: 'chatId' }, sort: { comparator: compareNewestFirst, orderFields: ['seq'] } },
      feed: { by: { chatId: 'chatId' }, sort: 'server-order' as const }
    })
  });

const corruptEntryOrder = (modelId: string, scopeName: string, id: string): void => {
  const target = getApplyTarget(modelId);
  const scopeKey = target.readAllScopeKeys().find(key => key.includes(scopeName))!;
  const tail = target.readScopeEntries(scopeKey).at(-1)!.orderKey;
  getApplyRuntime().commit(createCommitEnvelope([{ kind: 'scope-delta', model: modelId, scopeKey, append: [{ id, orderKey: `${tail}zz` }], detach: [] }]));
};

afterEach(() => resetRuntime());

describe('scope order authority', () => {
  it('materializes the declared comparator order even when persisted entry order is corrupt', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Model = defineRows('SpecScopeOrderComparator');
    Model.insertMany([
      { id: 'newest', chatId: 'c1', seq: 30 },
      { id: 'middle', chatId: 'c1', seq: 20 },
      { id: 'oldest', chatId: 'c1', seq: 10 }
    ]);
    // A history landing once placed the newest row at the tail of the persisted index.
    corruptEntryOrder('SpecScopeOrderComparator', 'thread', 'newest');

    expect(Model.thread({ chatId: 'c1' }).read().map(row => row.id)).toEqual(['newest', 'middle', 'oldest']);
    const reader = renderCounted(() => Model.thread({ chatId: 'c1' }).use().data.map(row => row.id));
    expect(reader.result()).toEqual(['newest', 'middle', 'oldest']);
    reader.unmount();
  });

  it('keeps live updates in comparator order on top of a corrupt persisted index', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Model = defineRows('SpecScopeOrderLive');
    Model.insertMany([
      { id: 'newest', chatId: 'c1', seq: 30 },
      { id: 'oldest', chatId: 'c1', seq: 10 }
    ]);
    corruptEntryOrder('SpecScopeOrderLive', 'thread', 'newest');

    const reader = renderCounted(() => Model.thread({ chatId: 'c1' }).use().data.map(row => row.id));
    act(() => {
      Model.insert({ id: 'between', chatId: 'c1', seq: 20 });
    });
    expect(reader.result()).toEqual(['newest', 'between', 'oldest']);
    reader.unmount();
  });

  it('keeps server-order scopes on the persisted entry order', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Model = defineRows('SpecScopeOrderServer');
    Model.insertMany([
      { id: 'first', chatId: 'c1', seq: 10 },
      { id: 'second', chatId: 'c1', seq: 30 },
      { id: 'third', chatId: 'c1', seq: 20 }
    ]);

    expect(Model.feed({ chatId: 'c1' }).read().map(row => row.id)).toEqual(['first', 'second', 'third']);
    const reader = renderCounted(() => Model.feed({ chatId: 'c1' }).use().data.map(row => row.id));
    expect(reader.result()).toEqual(['first', 'second', 'third']);
    reader.unmount();
  });
});
