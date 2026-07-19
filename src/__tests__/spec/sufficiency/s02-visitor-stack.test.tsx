import { act } from 'react-test-renderer';
import { defineModel, f } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

const createUsers = (id: string) =>
  defineModel({
    id,
    name: id,
    fields: { fullName: f.str(), avatarUrl: f.str() }
  });

type Users = ReturnType<typeof createUsers>;
type User = NonNullable<ReturnType<Users['get']>>;

const seedUsers = (users: Users) => {
  users.insertStoredMany(
    Array.from({ length: 4 }, (_, index) => ({ id: String(index), fullName: `Visitor ${index}`, avatarUrl: `avatar-${index}` }))
  );
};

describe('visitor avatar stack sufficiency', () => {
  it('keeps the stack stable when an unrelated user changes', () => {
    setupSpecRuntime();
    const users = createUsers('SpecVisitorStable');
    seedUsers(users);
    const ids = ['0', '1', '2'];
    const stack = renderCounted(() => {
      const rows = users.use.byIds(ids);
      const byId = new Map(rows.map(row => [row.id, row]));
      return ids.map(id => byId.get(id)?.avatarUrl);
    });
    const initial = stack.result();
    const before = stack.renders();

    act(() => {
      users.patch('3', { fullName: 'Unrelated Visitor' });
    });

    expect(stack.renders() - before).toBe(0);
    expect(stack.result()).toBe(initial);
    stack.unmount();
  });

  // GATE-PENDING(G6): Return stable rows and byId projections from byIds.
  test.failing('provides a stable byId map that changes with a member row', () => {
    setupSpecRuntime();
    const users = createUsers('SpecVisitorMap');
    seedUsers(users);
    const ids = ['0', '1', '2'];
    const stack = renderCounted(() => users.use.byIds(ids) as unknown as { rows: User[]; byId: Map<string, User> });
    const initial = stack.result();

    expect(initial.rows.map(row => row.id)).toEqual(ids);
    expect(ids.map(id => initial.byId.get(id)?.avatarUrl)).toEqual(['avatar-0', 'avatar-1', 'avatar-2']);
    act(() => {
      users.patch('3', { fullName: 'Unrelated Visitor' });
    });
    expect(stack.result().byId).toBe(initial.byId);
    act(() => {
      users.patch('1', { avatarUrl: 'avatar-1-updated' });
    });
    expect(stack.result().byId).not.toBe(initial.byId);
    expect(stack.result().byId.get('1')?.avatarUrl).toBe('avatar-1-updated');
    stack.unmount();
  });

  // GATE-PENDING(G6): Treat nullish id collections as an unsubscribed empty read.
  test.failing('reads nullish ids as empty without subscribing', () => {
    setupSpecRuntime();
    const users = createUsers('SpecVisitorNullish');
    seedUsers(users);
    const readByIds = users.use.byIds as unknown as (ids: string[] | null | undefined) => { rows: User[]; byId: Map<string, User> };
    const stack = renderCounted(() => readByIds(undefined));

    expect(stack.result().rows).toEqual([]);
    expect(stack.result().byId).toEqual(new Map());
    const before = stack.renders();
    act(() => {
      users.patch('1', { avatarUrl: 'ignored' });
    });
    expect(stack.renders() - before).toBe(0);
    stack.unmount();
  });
});
