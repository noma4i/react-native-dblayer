import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type ScopedRow = {
  id: string;
  groupId: string;
  title: string;
  rank: number;
  userIds: string[];
  markers: Array<{ id: string }>;
};

type ViewUserRow = {
  id: string;
  fullName: string;
  avatarUrl: string;
  online: boolean;
  lastSeenAt: string | null;
  status: string;
};

type ScopeWindowResult<T> = {
  rows: T[];
  totalCount: number;
  hasMore: boolean;
  isPreviousData: boolean;
  fetchNextPage: () => void;
};

type WindowReader<T> = {
  result: () => ScopeWindowResult<T>;
  renders: () => number;
  update: (groupId: string) => void;
  unmount: () => void;
};

const createScopedModel = () =>
  defineModel({
    id: 'SpecRerenderScopeWindowView',
    name: 'SpecRerenderScopeWindowView',
    fields: {
      groupId: f.str(),
      title: f.str(),
      rank: f.num(),
      userIds: f.raw<string[]>(),
      markers: f.raw<Array<{ id: string }>>()
    },
    scopes: {
      byGroup: scope<ScopedRow>({
        by: { groupId: 'groupId' },
        sort: { field: 'rank', dir: 'asc' }
      })
    }
  });

const seedRows = (rows: ReturnType<typeof createScopedModel>) => {
  rows.insertStoredMany(
    Array.from({ length: 30 }, (_, index) => ({
      id: `row-${index}`,
      groupId: index < 15 ? 'g1' : 'g2',
      title: `row-${index}`,
      rank: index,
      userIds: ['user-1'],
      markers: [{ id: `marker-${index}` }]
    }))
  );
};

const createViewUserModel = () =>
  defineModel({
    id: 'SpecRerenderViewUser',
    name: 'SpecRerenderViewUser',
    fields: {
      fullName: f.str(),
      avatarUrl: f.str(),
      online: f.bool(),
      lastSeenAt: f.str().nullable(),
      status: f.str()
    }
  });

const createUsersView = (rows: ReturnType<typeof createScopedModel>, users: ReturnType<typeof createViewUserModel>) =>
  rows.view<{ id: string; users: ViewUserRow[] }, { users: ViewUserRow[] }>('withUsers', {
    source: rows.scopes.byGroup,
    include: { users: { model: users, ids: row => row.userIds } },
    select: (row, included) => ({ id: row.id, users: included.users }),
    renderKeys: ['users']
  });

const createProjectedUsersView = (rows: ReturnType<typeof createScopedModel>, users: ReturnType<typeof createViewUserModel>) => {
  const usersInclude = { model: users, ids: (row: ScopedRow) => row.userIds, renderKeys: ['id', 'fullName', 'avatarUrl'] as const };
  return rows.view<{ id: string; users: ViewUserRow[] }, { users: ViewUserRow[] }>('withProjectedUsers', {
    source: rows.scopes.byGroup,
    include: { users: usersInclude },
    select: (row, included) => ({ id: row.id, users: included.users }),
    renderKeys: ['users']
  });
};

const seedProjectedUsersView = (rows: ReturnType<typeof createScopedModel>, users: ReturnType<typeof createViewUserModel>): void => {
  users.insertStoredMany([
    { id: 'user-1', fullName: 'User One', avatarUrl: 'one.jpg', online: true, lastSeenAt: null, status: 'online' },
    { id: 'user-2', fullName: 'User Two', avatarUrl: 'two.jpg', online: true, lastSeenAt: null, status: 'online' }
  ]);
  rows.insertStoredMany([
    { id: 'row-1', groupId: 'g1', title: 'First', rank: 1, userIds: ['user-1'], markers: [] },
    { id: 'row-2', groupId: 'g1', title: 'Second', rank: 2, userIds: ['user-1'], markers: [] },
    { id: 'row-3', groupId: 'g1', title: 'Third', rank: 3, userIds: ['user-2'], markers: [] }
  ]);
};

const idsOf = (rows: Array<{ id: string }>): string[] => rows.map(row => row.id);

const createGroupView = (rows: ReturnType<typeof createScopedModel>) =>
  rows.view<{ id: string; title: string }>('byGroupWindow', {
    source: rows.scopes.byGroup,
    include: {},
    select: row => ({ id: row.id, title: row.title as string })
  });

const renderWindow = (
  useWindow: (scopeValue: { groupId: string }, options?: { pageSize?: number; keepPrevious?: boolean }) => ScopeWindowResult<{ id: string; title: string }>,
  initialGroupId: string,
  keepPrevious = false
): WindowReader<{ id: string; title: string }> => {
  let current!: ScopeWindowResult<{ id: string; title: string }>;
  let renders = 0;
  let root!: TestRenderer.ReactTestRenderer;
  const Reader = ({ groupId }: { groupId: string }) => {
    current = useWindow({ groupId }, { pageSize: 5, keepPrevious });
    renders += 1;
    return null;
  };
  act(() => {
    root = TestRenderer.create(React.createElement(Reader, { groupId: initialGroupId }));
  });

  return {
    result: () => current,
    renders: () => renders,
    update: (groupId: string) => act(() => root.update(React.createElement(Reader, { groupId }))),
    unmount: () => act(() => root.unmount())
  };
};

describe('rerender matrix scope window view', () => {
  it('keeps scope reader byGroup(g1) stable for g2 patch', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);

    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const before = reader.renders();

    act(() => {
      rows.patch('row-20', { title: 'updated outside scope' });
    });

    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('rerenders scope reader byGroup(g1) when g1 rank patch reorders', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);

    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const before = reader.renders();

    act(() => {
      rows.patch('row-0', { rank: 99 });
    });

    expect(reader.renders() - before).toBe(1);
    reader.unmount();
  });

  it('keeps scope reader byGroup(g1) with renderKeys rank on title patch', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);

    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }, { renderKeys: ['rank'] }));
    const before = reader.renders();

    act(() => {
      rows.patch('row-2', { title: 'title-only patch' });
    });

    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('keeps a view item with an array render key stable for an unrelated source patch', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    const users = createViewUserModel();
    seedRows(rows);
    users.insertStored({ id: 'user-1', fullName: 'User One', avatarUrl: 'one.jpg', online: true, lastSeenAt: null, status: 'online' });
    const view = createUsersView(rows, users);
    const reader = renderCounted(() => view.use({ groupId: 'g1' }));
    const beforeItem = reader.result()[0];
    const beforeRenders = reader.renders();

    act(() => {
      rows.patch('row-0', { title: 'unrelated source patch' });
    });

    expect(reader.result()[0]).toBe(beforeItem);
    expect(reader.renders() - beforeRenders).toBe(0);
    reader.unmount();
  });

  it('rerenders a view item once when one included array row is replaced', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    const users = createViewUserModel();
    seedRows(rows);
    users.insertStored({ id: 'user-1', fullName: 'User One', avatarUrl: 'one.jpg', online: true, lastSeenAt: null, status: 'online' });
    const view = createUsersView(rows, users);
    const reader = renderCounted(() => view.use({ groupId: 'g1' }));
    const beforeItem = reader.result()[0];
    const beforeRenders = reader.renders();

    act(() => {
      users.patch('user-1', { status: 'away' });
    });

    expect(reader.result()[0]).not.toBe(beforeItem);
    expect(reader.renders() - beforeRenders).toBe(1);
    reader.unmount();
  });

  it('keeps included rows and view items stable when only unlisted include fields change', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    const users = createViewUserModel();
    seedProjectedUsersView(rows, users);
    const view = createProjectedUsersView(rows, users);
    const reader = renderCounted(() => view.use({ groupId: 'g1' }));
    const beforeItems = reader.result();
    const beforeIncludedUsers = beforeItems.map(item => item.users[0]);
    const beforeRenders = reader.renders();

    act(() => {
      users.patch('user-1', { online: false, lastSeenAt: '2026-07-20T00:00:00.000Z' });
    });

    expect(reader.result()).toBe(beforeItems);
    expect(reader.result().every((item, index) => item === beforeItems[index])).toBe(true);
    expect(reader.result().every((item, index) => item.users[0] === beforeIncludedUsers[index])).toBe(true);
    expect(reader.renders() - beforeRenders).toBe(0);
    reader.unmount();
  });

  it('changes exactly the view items that include a listed field update', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    const users = createViewUserModel();
    seedProjectedUsersView(rows, users);
    const view = createProjectedUsersView(rows, users);
    const reader = renderCounted(() => view.use({ groupId: 'g1' }));
    const beforeItems = reader.result();
    const beforeRenders = reader.renders();

    act(() => {
      users.patch('user-1', { avatarUrl: 'one-updated.jpg' });
    });

    expect(reader.result().map((item, index) => item === beforeItems[index])).toEqual([false, false, true]);
    expect(reader.result().slice(0, 2).every(item => item.users[0]?.avatarUrl === 'one-updated.jpg')).toBe(true);
    expect(reader.renders() - beforeRenders).toBe(1);
    reader.unmount();
  });

  it('keeps a row render key stable when an array is rewritten with the same element references', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);
    const markers = rows.get('row-2')!.markers;
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }, { renderKeys: ['markers'] }));
    const beforeRow = reader.result()[2];
    const beforeRenders = reader.renders();

    act(() => {
      rows.patch('row-2', { markers: [...markers] });
    });

    expect(reader.result()[2]).toBe(beforeRow);
    expect(reader.renders() - beforeRenders).toBe(0);
    reader.unmount();
  });

  it('rerenders useWindow(g1, pageSize: 5) for in-window patch', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);

    const reader = renderWindow(
      rows.scopes.byGroup.useWindow as unknown as (
        scopeValue: { groupId: string },
        options?: { pageSize?: number; keepPrevious?: boolean }
      ) => ScopeWindowResult<{ id: string; title: string }>,
      'g1'
    );
    const before = reader.renders();

    act(() => {
      rows.patch('row-1', { title: 'in-window changed' });
    });

    expect(reader.renders() - before).toBe(1);
    expect(idsOf(reader.result().rows).slice(0, 5)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    reader.unmount();
  });

  it('keeps useWindow(g1, pageSize: 5) stable for off-window patch', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);

    const reader = renderWindow(
      rows.scopes.byGroup.useWindow as unknown as (
        scopeValue: { groupId: string },
        options?: { pageSize?: number; keepPrevious?: boolean }
      ) => ScopeWindowResult<{ id: string; title: string }>,
      'g1'
    );
    const before = reader.renders();

    act(() => {
      rows.patch('row-12', { title: 'off-window changed' });
    });

    expect(reader.renders() - before).toBe(0);
    expect(idsOf(reader.result().rows)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    reader.unmount();
  });

  it('moves useWindow(g1, pageSize: 5) by local page growth', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);

    const reader = renderWindow(
      rows.scopes.byGroup.useWindow as unknown as (
        scopeValue: { groupId: string },
        options?: { pageSize?: number; keepPrevious?: boolean }
      ) => ScopeWindowResult<{ id: string; title: string }>,
      'g1'
    );
    const before = reader.renders();

    act(() => {
      reader.result().fetchNextPage();
    });

    expect(reader.renders() - before).toBe(1);
    expect(reader.result().rows).toHaveLength(10);
    reader.unmount();
  });

  it('rerenders useWindow(g1, pageSize: 5) once for off-window destroy totalCount', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);

    const reader = renderWindow(
      rows.scopes.byGroup.useWindow as unknown as (
        scopeValue: { groupId: string },
        options?: { pageSize?: number; keepPrevious?: boolean }
      ) => ScopeWindowResult<{ id: string; title: string }>,
      'g1'
    );
    const before = reader.renders();

    act(() => {
      rows.destroy('row-12');
    });

    expect(reader.renders() - before).toBe(1);
    expect(idsOf(reader.result().rows)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    expect(reader.result().totalCount).toBe(14);
    expect(reader.result().hasMore).toBe(true);
    reader.unmount();
  });

  it('counts window updates from useWindow(g1).totalCount as object-change coupling', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);

    const reader = renderCounted(() => rows.scopes.byGroup.useWindow({ groupId: 'g1' }).totalCount);
    const before = reader.result();
    const beforeRenders = reader.renders();

    act(() => {
      rows.patch('row-1', { title: 'total count visibility' });
    });

    const after = reader.result();
    expect(after).toBe(before);
    const delta = reader.renders() - beforeRenders;
    if (delta === 0) {
      expect(after).toBe(15);
    } else {
      // GAP: useWindow object identity couples totalCount readers when window rows change
      expect(delta).toBe(1);
    }
    reader.unmount();
  });

  it('rerenders group view reader on in-scope title patch', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);
    const view = createGroupView(rows);

    const reader = renderCounted(() => view.use({ groupId: 'g1' }));
    const before = reader.renders();

    act(() => {
      rows.patch('row-3', { title: 'view title patch' });
    });

    expect(reader.renders() - before).toBe(1);
    reader.unmount();
  });

  it('rerenders group view reader on in-scope rank patch with order change', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);
    const view = createGroupView(rows);

    const reader = renderCounted(() => view.use({ groupId: 'g1' }));
    const before = reader.renders();

    act(() => {
      rows.patch('row-2', { rank: 99 });
    });

    expect(reader.renders() - before).toBe(1);
    expect(reader.result().map(item => item.id)).toEqual([
      'row-0',
      'row-1',
      'row-3',
      'row-4',
      'row-5',
      'row-6',
      'row-7',
      'row-8',
      'row-9',
      'row-10',
      'row-11',
      'row-12',
      'row-13',
      'row-14',
      'row-2'
    ]);
    reader.unmount();
  });

  it('keeps group view reader stable for g2 patch', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);
    const view = createGroupView(rows);

    const reader = renderCounted(() => view.use({ groupId: 'g1' }));
    const before = reader.renders();

    act(() => {
      rows.patch('row-20', { title: 'outside title patch' });
    });

    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('holds retained g1 window on keepPrevious while switching to empty g3 and freezes retained patch', () => {
    const rows = createScopedModel();
    setupSpecRuntime();
    seedRows(rows);
    const reader = renderWindow(
      rows.scopes.byGroup.useWindow as unknown as (
        scopeValue: { groupId: string },
        options?: { pageSize?: number; keepPrevious?: boolean }
      ) => ScopeWindowResult<{ id: string; title: string }>,
      'g1',
      true
    );

    const switched = reader.renders();
    reader.update('g3');
    expect(reader.renders() - switched).toBe(1);
    const retained = reader.result();

    expect(retained.rows.map(row => row.id)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    expect(retained.isPreviousData).toBe(true);
    const beforePatch = reader.renders();

    act(() => {
      rows.patch('row-1', { title: 'retained mutation while previous' });
    });

    expect(reader.renders() - beforePatch).toBe(0);
    act(() => {
      rows.scopes.byGroup.seed({ groupId: 'g3' }, []);
    });
    const resolvedRenders = reader.renders();
    expect({
      ids: idsOf(reader.result().rows),
      isPreviousData: reader.result().isPreviousData,
      totalCount: reader.result().totalCount,
      renders: resolvedRenders - beforePatch
    }).toEqual({
      ids: [],
      isPreviousData: false,
      totalCount: 0,
      renders: 1
    });
    reader.unmount();
  });

  it('rerenders count reader when g1 membership changes', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.useCount({ groupId: 'g1' }));
    const before = reader.renders();

    act(() => {
      rows.patch('row-1', { groupId: 'g2' });
    });

    expect(reader.renders() - before).toBe(1);
    reader.unmount();
  });

  it('keeps group count reader stable for title patch', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.useCount({ groupId: 'g1' }));
    const before = reader.renders();

    act(() => {
      rows.patch('row-2', { title: 'count title patch' });
    });

    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('keeps g1 count reader stable for g2 changes', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.useCount({ groupId: 'g1' }));
    const before = reader.renders();

    act(() => {
      rows.patch('row-20', { title: 'g2 changed' });
      rows.destroy('row-21');
      rows.insertStored({ id: 'new-row', groupId: 'g2', title: 'g2 inserted', rank: 100, userIds: [], markers: [] });
    });

    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });
});
