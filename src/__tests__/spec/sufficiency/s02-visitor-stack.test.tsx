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
      const { byId } = users.use.byIds(ids);
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

  it('provides a stable byId map that changes with a member row', () => {
    setupSpecRuntime();
    const users = createUsers('SpecVisitorMap');
    seedUsers(users);
    const ids = ['0', '1', '2'];
    const stack = renderCounted(() => users.use.byIds(ids));
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

  it('reads nullish ids as empty without subscribing', () => {
    setupSpecRuntime();
    const users = createUsers('SpecVisitorNullish');
    seedUsers(users);
    const stack = renderCounted(() => users.use.byIds(undefined));

    expect(stack.result().rows).toEqual([]);
    expect(stack.result().byId).toEqual(new Map());
    const before = stack.renders();
    act(() => {
      users.patch('1', { avatarUrl: 'ignored' });
    });
    expect(stack.renders() - before).toBe(0);
    stack.unmount();
  });

  it('indexes projections that omit the stored id', () => {
    setupSpecRuntime();
    const users = createUsers('SpecVisitorProjectionMap');
    seedUsers(users);
    const stack = renderCounted(() => users.use.byIds(['0', '1'], { select: row => ({ avatarUrl: row.avatarUrl }) }));
    expect(stack.result().byId.get('1')).toEqual({ avatarUrl: 'avatar-1' });
    expect(stack.result().byId.has('undefined')).toBe(false);
    stack.unmount();
  });
});
