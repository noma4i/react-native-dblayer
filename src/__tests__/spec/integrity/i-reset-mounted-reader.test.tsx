import { act } from 'react';
import { defineModelRuntime, f, resetRuntime } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; accountId: string; nickname: string };

let suffix = 0;
const createUsers = () => {
  setupSpecRuntime();
  return defineModelRuntime({
    id: `SpecResetMountedReader${(suffix += 1)}`,
    name: `SpecResetMountedReader${suffix}`,
    fields: { accountId: f.str(), nickname: f.str() },
    scopes: { byAccount: { by: { accountId: 'accountId' } } }
  });
};

const rowA: Row = { id: 'user-a', accountId: 'A', nickname: 'account-a' };
const rowB: Row = { id: 'user-b', accountId: 'B', nickname: 'account-b' };

/**
 * R22: a runtime reset under a MOUNTED reader moves that reader onto the new runtime's data.
 * The account-switch shape: the provider tree stays mounted while resetRuntime runs, then the new
 * account's rows are seeded. A reader frozen on the previous generation serves the old account.
 */
describe('reset under a mounted reader', () => {
  it('moves a mounted where-builder reader onto rows seeded after reset', () => {
    const errorSpy = jest.spyOn(console, 'error');
    const rows = createUsers();
    rows.insert(rowA);
    const reader = renderCounted(() => rows.use.where({}).orderBy('nickname', 'asc').rows());
    expect(reader.result().map(row => row.nickname)).toEqual(['account-a']);

    act(() => {
      resetRuntime();
    });
    // The previous account's rows vanish AT reset, not at the first new write.
    expect(reader.result()).toEqual([]);
    act(() => {
      rows.insert(rowB);
    });

    // The imperative read and the mounted reader name one result after the reset completes.
    expect(rows.where({}).map(row => row.nickname)).toEqual(['account-b']);
    expect(reader.result().map(row => row.nickname)).toEqual(['account-b']);
    const hookOrderErrors = errorSpy.mock.calls.filter(call => call.some(arg => typeof arg === 'string' && arg.includes('change in the order of Hooks')));
    expect(hookOrderErrors).toEqual([]);
    errorSpy.mockRestore();
    reader.unmount();
  });

  it('moves a mounted use.count reader onto the count seeded after reset', () => {
    const rows = createUsers();
    rows.insert(rowA);
    rows.insert({ ...rowA, id: 'user-a2', nickname: 'account-a2' });
    const reader = renderCounted(() => rows.use.count());
    expect(reader.result()).toBe(2);

    act(() => {
      resetRuntime();
    });
    expect(reader.result()).toBe(0);
    act(() => {
      rows.insert(rowB);
    });

    expect(reader.result()).toBe(1);
    reader.unmount();
  });

  it('moves a mounted use.first reader onto the row seeded after reset', () => {
    const rows = createUsers();
    rows.insert(rowA);
    const reader = renderCounted(() => rows.use.first(null, { orderBy: { field: 'nickname', direction: 'asc' } }));
    expect(reader.result()).toMatchObject({ nickname: 'account-a' });

    act(() => {
      resetRuntime();
    });
    expect(reader.result()).toBeUndefined();
    act(() => {
      rows.insert(rowB);
    });

    expect(reader.result()).toMatchObject({ nickname: 'account-b' });
    reader.unmount();
  });

  it('counts rows seeded after reset in a scope count that was empty at reset', () => {
    const rows = createUsers();
    rows.insert(rowA);
    const reader = renderCounted(() => rows.scopes.byAccount.useCount({ accountId: 'B' }));
    expect(reader.result()).toBe(0);

    act(() => {
      resetRuntime();
    });
    act(() => {
      rows.insert(rowB);
    });

    expect(reader.result()).toBe(1);
    reader.unmount();
  });

  it('serves rows seeded after reset in a scope reader that was empty and unresolved at reset', () => {
    const rows = createUsers();
    rows.insert(rowA);
    const reader = renderCounted(() => rows.scopes.byAccount.use({ accountId: 'B' }));
    expect(reader.result()).toEqual([]);

    act(() => {
      resetRuntime();
    });
    act(() => {
      rows.insert(rowB);
    });

    expect(reader.result().map(row => (row as Row).nickname)).toEqual(['account-b']);
    reader.unmount();
  });

  it('moves a mounted scope window reader onto rows seeded after reset', () => {
    const rows = createUsers();
    rows.insert(rowA);
    const reader = renderCounted(() => rows.scopes.byAccount.useWindow({ accountId: 'A' }, { pageSize: 5 }));
    expect(reader.result().rows.map(row => (row as Row).nickname)).toEqual(['account-a']);

    act(() => {
      resetRuntime();
    });
    act(() => {
      rows.insert({ ...rowB, accountId: 'A', nickname: 'account-a-next' });
    });

    expect(reader.result().rows.map(row => (row as Row).nickname)).toEqual(['account-a-next']);
    reader.unmount();
  });

  it('does not re-render an empty reader whose value reset leaves unchanged', () => {
    const rows = createUsers();
    const reader = renderCounted(() => rows.use.where({}).rows());
    expect(reader.result()).toEqual([]);
    const renders = reader.renders();

    act(() => {
      resetRuntime();
    });

    expect(reader.result()).toEqual([]);
    expect(reader.renders()).toBe(renders);
    reader.unmount();
  });

  it('moves a mounted use.find reader onto the row seeded after reset', () => {
    const rows = createUsers();
    rows.insert(rowA);
    const reader = renderCounted(() => rows.use.find('user-a'));
    expect(reader.result()).toMatchObject({ nickname: 'account-a' });

    act(() => {
      resetRuntime();
    });
    act(() => {
      rows.insert({ ...rowA, nickname: 'account-a-fresh' });
    });

    expect(reader.result()).toMatchObject({ nickname: 'account-a-fresh' });
    reader.unmount();
  });
});
