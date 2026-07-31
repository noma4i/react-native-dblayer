import { act } from 'react';
import { configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted, settle, renderCountedInProvider } from '../helpers/harness';

type FriendState = { userId: string; id: string; kind: string; fullName: string };
type QueryState = { userId: string; id: string; kind: string; fullName: string };
type QueryResponse = { users: QueryState[] };
type ScopeValue = { userId: string; kind: string };

const document = { kind: 'Document', definitions: [] } as never;

const createUserModel = () =>
  defineModelRuntime({
    id: 'SpecConsumerCoverageComplete',
    name: 'SpecConsumerCoverageComplete',
    fields: {
      userId: f.str(),
      id: f.str(),
      kind: f.str(),
      fullName: f.str()
    },
    scopes: {
      blocked: ({
        by: { userId: 'userId', kind: 'kind' },
        sort: { field: 'fullName', dir: 'asc' }
      }),
      friends: ({
        by: { userId: 'userId', kind: 'kind' },
        sort: { field: 'fullName', dir: 'asc' }
      })
    }
  });

describe('coverage complete and scope isolation', () => {
  it('detaches missing rows on complete payloads while entities remain in storage', async () => {
    const responses: QueryResponse[] = [
      {
        users: [
          { userId: 'viewer-1', id: 'blocked-1', kind: 'blocked', fullName: 'Ada' },
          { userId: 'viewer-1', id: 'blocked-2', kind: 'blocked', fullName: 'Bruno' }
        ]
      },
      {
        users: [{ userId: 'viewer-1', id: 'blocked-1', kind: 'blocked', fullName: 'Ada' }]
      }
    ];

    const transport = createMockTransport({
      query: async <TData,>() => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected query response');
        return { data: next as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const users = createUserModel();
    const query = users.query<QueryResponse, ScopeValue, ScopeValue, FriendState>('blocked-users', {
      document,
      vars: value => ({ userId: value.userId, kind: value.kind }),
      select: data => data.users,
      into: users.scopes.blocked,
      coverage: 'complete'
    });

    const queryReader = renderCountedInProvider(() => query.use({ userId: 'viewer-1', kind: 'blocked' }));
    const blockedReader = renderCounted(() => users.scopes.blocked.use({ userId: 'viewer-1', kind: 'blocked' }));

    await settle();
    expect(blockedReader.result().map(row => row.id)).toEqual(['blocked-1', 'blocked-2']);

    const before = blockedReader.renders();
    await act(async () => {
      await queryReader.result().refresh();
    });
    await settle();

    expect(blockedReader.result().map(row => row.id)).toEqual(['blocked-1']);
    expect(blockedReader.renders() - before).toBe(1);
    expect(users.find('blocked-2')).toBeTruthy();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'scope-complete-detach', model: users.modelId, count: 1 });

    blockedReader.unmount();
    queryReader.unmount();
  });

  it('re-sorts blocked scope when a row name changes and rerenders once', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const users = createUserModel();
    users.insert({ userId: 'viewer-1', id: 'blocked-1', kind: 'blocked', fullName: 'Zara' });
    users.insert({ userId: 'viewer-1', id: 'blocked-2', kind: 'blocked', fullName: 'Mona' });

    const blockedReader = renderCounted(() => users.scopes.blocked.use({ userId: 'viewer-1', kind: 'blocked' }));
    expect(blockedReader.result().map(row => row.id)).toEqual(['blocked-2', 'blocked-1']);

    const before = blockedReader.renders();
    act(() => {
      users.update('blocked-1', { fullName: 'Aaron' });
    });

    expect(blockedReader.result().map(row => row.id)).toEqual(['blocked-1', 'blocked-2']);
    expect(blockedReader.renders() - before).toBe(1);
    blockedReader.unmount();
  });

  it('keeps blocked scope isolated from friends-scope changes on the same model', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const users = createUserModel();
    users.insert({ userId: 'viewer-1', id: 'blocked-1', kind: 'blocked', fullName: 'Alice' });
    users.insert({ userId: 'viewer-1', id: 'friend-1', kind: 'friend', fullName: 'Bob' });

    const blockedReader = renderCounted(() => users.scopes.blocked.use({ userId: 'viewer-1', kind: 'blocked' }));
    const friendReader = renderCounted(() => users.scopes.friends.use({ userId: 'viewer-1', kind: 'friend' }));
    const beforeBlocked = blockedReader.renders();

    users.update('friend-1', { fullName: 'Bobby' });

    expect(blockedReader.renders() - beforeBlocked).toBe(0);
    expect(friendReader.result().map(row => row.id)).toEqual(['friend-1']);

    blockedReader.unmount();
    friendReader.unmount();
  });
});
