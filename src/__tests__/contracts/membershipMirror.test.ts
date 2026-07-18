import { collectGarbage, defineModel, f, flushPersistence, hasMany, replayJournal, resetRuntime, scope, trimRowsPerScope } from '../../index';
import { ensureMembershipCollection, membershipCollectionFor } from '../../core/tanstack/facade';
import { createContractScenario } from '../helpers/contractScenario';
import { createMemoryStorage } from '../helpers/memoryStorage';

const document = { kind: `Document`, definitions: [] } as never;
const feed = { feed: `main` };

const orderedMembershipIds = (modelId: string, scopeKey: string, sort: { kind: `server-order` | `comparator` } | { kind: `field`; dir: `asc` | `desc` }): string[] =>
  membershipCollectionFor(modelId)
    .toArray.filter(row => row.scopeKey === scopeKey)
    .sort((left, right) => {
      if (sort.kind !== `field`) return (left.seq ?? 0) - (right.seq ?? 0);
      if (left.sortValue === right.sortValue) return left.rowId.localeCompare(right.rowId);
      const result = left.sortValue == null ? -1 : right.sortValue == null ? 1 : left.sortValue < right.sortValue ? -1 : 1;
      return sort.dir === `asc` ? result : -result;
    })
    .map(row => row.rowId);

const expectMembershipScope = (
  modelId: string,
  scopeKey: string,
  sort: { kind: `server-order` | `comparator` } | { kind: `field`; dir: `asc` | `desc` },
  expected: Array<{ id: string }>
): void => {
  expect(orderedMembershipIds(modelId, scopeKey, sort)).toEqual(expected.map(row => row.id));
};

describe(`membership collection mirror`, () => {
  afterEach(() => resetRuntime());

  it(`mirrors page append and complete detach in server order`, async () => {
    const pages = [
      [
        { id: `a`, title: `a` },
        { id: `b`, title: `b` }
      ],
      [{ id: `c`, title: `c` }],
      [
        { id: `b`, title: `b` },
        { id: `c`, title: `c` }
      ]
    ];
    createContractScenario({
      transport: { query: async <TData>() => ({ data: { rows: pages.shift() } as TData }) }
    });
    const model = defineModel({
      id: `MembershipPage`,
      name: `MembershipPage`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) }
    });
    const page = model.query(`page`, { document, select: data => (data as { rows: unknown[] }).rows, into: model.scopes.feed, coverage: `page` });
    await page.fetch(feed);
    await page.fetch(feed);
    expectMembershipScope(`MembershipPage`, `feed:${JSON.stringify(feed)}`, { kind: `server-order` }, model.scopes.feed.read(feed));

    const complete = model.query(`complete`, { document, select: data => (data as { rows: unknown[] }).rows, into: model.scopes.feed, coverage: `complete` });
    await complete.fetch(feed);
    expectMembershipScope(`MembershipPage`, `feed:${JSON.stringify(feed)}`, { kind: `server-order` }, model.scopes.feed.read(feed));
  });

  it(`clears memberships on reset and repopulates after a query apply`, async () => {
    createContractScenario({ transport: { query: async <TData>() => ({ data: { rows: [{ id: `a`, title: `a` }] } as TData }) } });
    const model = defineModel({ id: `MembershipReset`, name: `MembershipReset`, fields: { title: f.str() }, scopes: { feed: scope({ sort: `server-order` }) } });
    const query = model.query(`reset`, { document, select: data => (data as { rows: unknown[] }).rows, into: model.scopes.feed, coverage: `complete` });
    await query.fetch(feed);
    resetRuntime();
    expect(ensureMembershipCollection(`MembershipReset`).toArray).toEqual([]);
    await query.fetch(feed);
    expect(membershipCollectionFor(`MembershipReset`).toArray).toHaveLength(1);
  });

  it(`seeds memberships before replay after restart`, async () => {
    const memory = createMemoryStorage();
    createContractScenario({ storage: memory, transport: { query: async <TData>() => ({ data: { rows: [{ id: `a`, title: `a` }] } as TData }) } });
    const first = defineModel({ id: `MembershipRestart`, name: `MembershipRestart`, fields: { title: f.str() }, scopes: { feed: scope({ sort: `server-order` }) } });
    const query = first.query(`restart`, { document, select: data => (data as { rows: unknown[] }).rows, into: first.scopes.feed, coverage: `complete` });
    await query.fetch(feed);
    flushPersistence();
    createContractScenario({ storage: memory });
    const restarted = defineModel({ id: `MembershipRestart`, name: `MembershipRestart`, fields: { title: f.str() }, scopes: { feed: scope({ sort: `server-order` }) } });
    replayJournal();
    expectMembershipScope(`MembershipRestart`, `feed:${JSON.stringify(feed)}`, { kind: `server-order` }, restarted.scopes.feed.read(feed));
  });

  it(`mirrors a field-sorted declarative scope after a member patch`, () => {
    createContractScenario();
    const model = defineModel({
      id: `MembershipSorted`,
      name: `MembershipSorted`,
      fields: { feedId: f.id(), rank: f.num() },
      scopes: { feed: scope({ by: { feed: `feedId` }, sort: { field: `rank`, dir: `asc` } }) }
    });
    model.insertStoredMany([
      { id: `a`, feedId: `main`, rank: 2 },
      { id: `b`, feedId: `main`, rank: 1 },
      { id: `c`, feedId: `main`, rank: 3 }
    ]);
    const key = `feed:${JSON.stringify(feed)}`;
    const collection = membershipCollectionFor(`MembershipSorted`);
    let writes = 0;
    const subscription = collection.subscribeChanges(changes => {
      writes += changes.length;
    });
    model.patch(`c`, { rank: 0 });
    expectMembershipScope(`MembershipSorted`, key, { kind: `field`, dir: `asc` }, model.scopes.feed.read(feed));
    expect(writes).toBe(1);
    subscription.unsubscribe();
  });

  it(`clears cascaded child memberships while preserving another scope`, () => {
    createContractScenario();
    const child = defineModel({
      id: `MembershipCascadeChild`,
      name: `MembershipCascadeChild`,
      fields: { parentId: f.id() },
      scopes: { feed: scope({ by: { feed: `parentId` }, sort: `server-order` }) }
    });
    const parent = defineModel({
      id: `MembershipCascadeParent`,
      name: `MembershipCascadeParent`,
      fields: {},
      relations: () => ({ children: hasMany(child, { foreignKey: `parentId`, dependent: `destroy` }) })
    });
    parent.insertStoredMany([{ id: `one` }, { id: `two` }]);
    child.insertStoredMany([
      { id: `a`, parentId: `one` },
      { id: `b`, parentId: `one` },
      { id: `c`, parentId: `one` },
      { id: `other`, parentId: `two` }
    ]);
    parent.destroy(`one`);
    const rows = membershipCollectionFor(`MembershipCascadeChild`).toArray;
    expect(rows.filter(row => row.scopeKey === `feed:${JSON.stringify({ feed: `one` })}`)).toEqual([]);
    expectMembershipScope(`MembershipCascadeChild`, `feed:${JSON.stringify({ feed: `two` })}`, { kind: `server-order` }, child.scopes.feed.read({ feed: `two` }));
  });

  it(`mirrors public scope trimming with contiguous order`, () => {
    createContractScenario();
    const model = defineModel({
      id: `MembershipTrim`,
      name: `MembershipTrim`,
      fields: { feedId: f.id(), rank: f.num() },
      scopes: { feed: scope({ by: { feed: `feedId` }, sort: `server-order` }) }
    });
    model.insertStoredMany(Array.from({ length: 6 }, (_, rank) => ({ id: `row-${rank}`, feedId: `main`, rank })));
    trimRowsPerScope(model, `feedId`, 3, (left, right) => Number(right.rank) - Number(left.rank));
    const key = `feed:${JSON.stringify(feed)}`;
    expectMembershipScope(`MembershipTrim`, key, { kind: `server-order` }, model.scopes.feed.read(feed));
    expect(membershipCollectionFor(`MembershipTrim`).toArray.filter(row => row.scopeKey === key).map(row => row.seq).sort()).toEqual([0, 1, 2]);
  });

  it(`deletes memberships when garbage collection removes a dead scope`, () => {
    createContractScenario();
    const model = defineModel({ id: `MembershipGc`, name: `MembershipGc`, fields: { feedId: f.id() }, scopes: { feed: scope({ by: { feed: `feedId` }, sort: `server-order` }) } });
    model.insertStored({ id: `orphan`, feedId: `dead` });
    model.destroy(`orphan`);
    collectGarbage();
    expect(membershipCollectionFor(`MembershipGc`).toArray).toEqual([]);
  });

  it(`emits one membership wave for one ten-row query apply`, async () => {
    createContractScenario({
      transport: { query: async <TData>() => ({ data: { rows: Array.from({ length: 10 }, (_, index) => ({ id: `row-${index}`, title: String(index) })) } as TData }) }
    });
    const model = defineModel({ id: `MembershipStorm`, name: `MembershipStorm`, fields: { title: f.str() }, scopes: { feed: scope({ sort: `server-order` }) } });
    const query = model.query(`storm`, { document, select: data => (data as { rows: unknown[] }).rows, into: model.scopes.feed, coverage: `complete` });
    const collection = ensureMembershipCollection(`MembershipStorm`);
    let callbacks = 0;
    const subscription = collection.subscribeChanges(() => {
      callbacks += 1;
    });
    await query.fetch(feed);
    expect(callbacks).toBe(1);
    subscription.unsubscribe();
  });
});
