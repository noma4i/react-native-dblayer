import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { act } from 'react';
import { configureDb, defineModel, defineShape, f, gql, type DbTransport } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type UserInput = {
  id: string;
  username: string;
};

type UpdateData = {
  updateUser: {
    user: UserInput;
  };
};

type UpdateVariables = {
  input: {
    id: string;
    username: string;
  };
};

type CreateData = {
  createUser: {
    user: UserInput;
  };
};

type CreateVariables = {
  input: {
    username: string;
  };
};

type DeleteData = {
  deleteUser: {
    success: boolean;
  };
};

type DeleteVariables = {
  input: {
    id: string;
  };
};

type RefreshData = {
  refreshUser: {
    user: UserInput;
  };
};

type RefreshVariables = {
  input: {
    id: string;
  };
};

const updateDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<UpdateData, UpdateVariables>;
const createDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<CreateData, CreateVariables>;
const deleteDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<DeleteData, DeleteVariables>;
const refreshDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<RefreshData, RefreshVariables>;

const UserSchema = defineShape<UserInput>()({
  username: f.str()
});

describe('v10 operation state', () => {
  it('exposes pending patch values through snapshot and reactive operation reads', async () => {
    let resolveUpdate!: (value: { data: UpdateData }) => void;
    const response = new Promise<{ data: UpdateData }>(resolve => {
      resolveUpdate = resolve;
    });
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => {
          const result = await response;
          return { data: result.data as TData };
        }
      })
    });
    const User = defineModel('SpecV10OperationUpdateUser', {
      schema: UserSchema,
      actions: {
        rename: gql.action(updateDocument, {
          result: 'updateUser',
          variables: input => ({ input }),
          kind: 'update',
          select: data => data.updateUser.user,
          optimistic: {
            id: input => input.id,
            patch: input => ({ username: input.username })
          }
        })
      }
    });
    User.insert({ id: 'user-1', username: 'before' });
    const reader = renderCounted(() => User.operation('user-1').use());

    let run!: Promise<UpdateData['updateUser'] | null>;
    act(() => {
      run = User.actions.rename.run({ id: 'user-1', username: 'after' });
    });

    expect(User.find('user-1')?.username).toBe('after');
    expect(User.operation('user-1').read()).toEqual({
      pending: true,
      failed: false,
      unsyncedChanges: { username: 'after' }
    });
    expect(reader.result()).toEqual({
      pending: true,
      failed: false,
      unsyncedChanges: { username: 'after' }
    });

    await act(async () => {
      resolveUpdate({
        data: {
          updateUser: {
            user: { id: 'user-1', username: 'after' }
          }
        }
      });
      await run;
    });

    expect(User.operation('user-1').read()).toEqual({
      pending: false,
      failed: false,
      unsyncedChanges: undefined
    });
    expect(reader.result()).toEqual({
      pending: false,
      failed: false,
      unsyncedChanges: undefined
    });
    reader.unmount();
  });

  it('exposes a retained insert failure through operation reads', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async () => {
          throw new Error('create failed');
        }
      })
    });
    const User = defineModel('SpecV10OperationFailedUser', {
      schema: UserSchema,
      actions: {
        create: gql.action(createDocument, {
          result: 'createUser',
          variables: input => ({ input }),
          kind: 'insert',
          select: data => data.createUser.user,
          optimistic: {
            build: (input, context) => ({
              id: context.tempId,
              username: input.username
            }),
            failure: 'keep'
          }
        })
      },
      maintenance: { dropTempRowsAfterMs: 1000 }
    });

    const run = User.actions.create.run({ username: 'new' }).catch(error => {
      throw error;
    });
    const tempId = User.where({ username: 'new' }).read()[0]?.id;
    expect(tempId).toBeDefined();
    await expect(run).rejects.toThrow('create failed');

    expect(User.operation(tempId).read()).toEqual({
      pending: false,
      failed: true,
      unsyncedChanges: undefined
    });
  });

  it('executes destroy and custom request actions through the owning model', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>(operation: Parameters<DbTransport['mutation']>[0]) => {
          if (operation.mutation === deleteDocument) return { data: { deleteUser: { success: true } } as TData };
          return {
            data: {
              refreshUser: {
                user: { id: 'user-2', username: 'landed' }
              }
            } as TData
          };
        }
      })
    });
    const User = defineModel('SpecV10OperationKindsUser', {
      schema: UserSchema,
      actions: {
        remove: gql.action(deleteDocument, {
          result: 'deleteUser',
          variables: input => ({ input }),
          kind: 'destroy',
          id: input => input.id,
          optimistic: true
        }),
        refresh: gql.action(refreshDocument, {
          result: 'refreshUser',
          variables: input => ({ input }),
          kind: 'custom',
          select: data => data.refreshUser.user
        })
      }
    });
    User.insert({ id: 'user-1', username: 'remove' });

    await expect(User.actions.remove.run({ id: 'user-1' })).resolves.toEqual({ success: true });
    expect(User.find('user-1')).toBeUndefined();

    await expect(User.actions.refresh.run({ id: 'user-2' })).resolves.toEqual({
      user: { id: 'user-2', username: 'landed' }
    });
    expect(User.find('user-2')).toEqual({ id: 'user-2', username: 'landed' });
  });
});
