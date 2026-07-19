import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f, resetRuntime } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

const createUsers = (id: string) =>
  defineModel({
    id,
    name: id,
    fields: {
      fullName: f.str(),
      avatarUrl: f.str(),
      connectionStatus: f.str(),
      online: f.bool(),
      lastInteraction: f.num()
    }
  });

type Users = ReturnType<typeof createUsers>;
type User = NonNullable<ReturnType<Users['get']>>;
type Projection = { avatarUrl: string; connectionStatus: string };

const seedUsers = (users: Users) => {
  users.insertStoredMany(
    Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      fullName: `User ${index}`,
      avatarUrl: `avatar-${index}`,
      connectionStatus: index % 2 === 0 ? 'online' : 'offline',
      online: index % 2 === 0,
      lastInteraction: index
    }))
  );
};

const renderAvatarList = (users: Users, targetProjection = false) => {
  const renders = new Map<string, number>();
  const values = new Map<string, Projection | undefined>();
  let root!: TestRenderer.ReactTestRenderer;

  const AvatarLeaf = ({ id }: { id: string }) => {
    const value = targetProjection
      ? users.use.row(id, {
          select: row => ({ avatarUrl: row.avatarUrl, connectionStatus: row.connectionStatus })
        })
      : users.use.row(id, {
          renderKeys: ['avatarUrl', 'connectionStatus']
        });
    renders.set(id, (renders.get(id) ?? 0) + 1);
    values.set(id, value as Projection | undefined);
    return React.createElement('avatar', { source: value?.avatarUrl, status: value?.connectionStatus });
  };

  const AvatarList = () => React.createElement(React.Fragment, null, Array.from({ length: 30 }, (_, index) => React.createElement(AvatarLeaf, { id: String(index), key: index })));

  act(() => {
    root = TestRenderer.create(React.createElement(AvatarList));
  });

  return { renders, values, unmount: () => act(() => root.unmount()) };
};

describe('avatar leaf sufficiency', () => {
  it('rerenders only the leaf whose selected avatar field changes', () => {
    setupSpecRuntime();
    const users = createUsers('SpecAvatarPatch');
    seedUsers(users);
    const list = renderAvatarList(users);
    const before = new Map(list.renders);

    act(() => {
      users.patch('7', { avatarUrl: 'avatar-7-updated' });
    });

    expect(Array.from({ length: 30 }, (_, index) => (list.renders.get(String(index)) ?? 0) - (before.get(String(index)) ?? 0))).toEqual(
      Array.from({ length: 30 }, (_, index) => (index === 7 ? 1 : 0))
    );
    list.unmount();
  });

  it('returns a stable field projection across unrelated row patches', () => {
    setupSpecRuntime();
    const users = createUsers('SpecAvatarProjection');
    seedUsers(users);
    const list = renderAvatarList(users, true);
    const initial = list.values.get('7');
    const before = list.renders.get('7');

    expect(Object.keys(initial ?? {}).sort()).toEqual(['avatarUrl', 'connectionStatus']);
    act(() => {
      users.patch('7', { fullName: 'Renamed User' });
    });
    expect((list.renders.get('7') ?? 0) - (before ?? 0)).toBe(0);
    expect(list.values.get('7')).toBe(initial);
    list.unmount();
  });

  it('stops all leaf renders and warnings after unmount', () => {
    setupSpecRuntime();
    const users = createUsers('SpecAvatarUnmount');
    seedUsers(users);
    const list = renderAvatarList(users);
    list.unmount();
    const before = new Map(list.renders);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    act(() => {
      users.patch('7', { avatarUrl: 'after-unmount' });
    });

    expect(list.renders).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('projects the first matching row with a stable reference', () => {
    setupSpecRuntime();
    const users = createUsers('SpecFirstProjection');
    seedUsers(users);
    const reader = renderCounted(() => users.use.first({ id: '7' }, { select: row => ({ avatarUrl: row.avatarUrl }) }));
    const initial = reader.result();
    const renders = reader.renders();
    act(() => users.patch('7', { fullName: 'Ignored rename' }));
    expect(reader.renders() - renders).toBe(0);
    expect(reader.result()).toBe(initial);
    reader.unmount();
  });

  it('projects builder rows with stable item and array references', () => {
    setupSpecRuntime();
    const users = createUsers('SpecBuilderProjection');
    seedUsers(users);
    const reader = renderCounted(() => users.use.where({ online: true }).select(row => ({ id: row.id, avatarUrl: row.avatarUrl })).rows());
    const initial = reader.result();
    const item = initial[0];
    const renders = reader.renders();
    act(() => users.patch('0', { fullName: 'Ignored builder rename' }));
    expect(reader.renders() - renders).toBe(0);
    expect(reader.result()).toBe(initial);
    expect(reader.result()[0]).toBe(item);
    reader.unmount();
  });

  it('rejects simultaneous select and render keys', () => {
    setupSpecRuntime();
    const users = createUsers('SpecProjectionValidation');
    seedUsers(users);
    const invalid = users.use.row as unknown as (id: string, options: { select: (row: User) => Projection; renderKeys: readonly string[] }) => Projection;
    expect(() => renderCounted(() => invalid('0', { select: row => ({ avatarUrl: row.avatarUrl, connectionStatus: row.connectionStatus }), renderKeys: ['avatarUrl'] }))).toThrow(
      'cannot use select and renderKeys together'
    );
  });

  it('recomputes a fresh projection after runtime reset', () => {
    setupSpecRuntime();
    const users = createUsers('SpecProjectionReset');
    seedUsers(users);
    const reader = renderCounted(() => users.use.row('7', { select: row => ({ avatarUrl: row.avatarUrl }) }));
    const initial = reader.result();
    act(() => {
      resetRuntime();
      users.insertStored({
        id: '7',
        fullName: 'Fresh User',
        avatarUrl: 'fresh-avatar',
        connectionStatus: 'online',
        online: true,
        lastInteraction: 1
      });
    });
    expect(reader.result()).not.toBe(initial);
    expect(reader.result()).toEqual({ avatarUrl: 'fresh-avatar' });
    reader.unmount();
  });
});
