import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f } from '../../../index';
import { setupSpecRuntime } from '../helpers/harness';

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
      ? (users.use.row as unknown as (rowId: string, options: { select: (row: NonNullable<ReturnType<Users['get']>>) => Projection }) => Projection | undefined)(id, {
          select: row => ({ avatarUrl: row.avatarUrl, connectionStatus: row.connectionStatus })
        })
      : users.use.row(id, { select: ['avatarUrl', 'connectionStatus'] });
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

  // GATE-PENDING(G1): Make row selectors return stable projection objects instead of whole rows.
  test.failing('returns a stable field projection across unrelated row patches', () => {
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
});
