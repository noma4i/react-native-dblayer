import { configureDb, defineModelRuntime, f, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type GroupRow = { id: string; groupId: string; label: string };
type GroupScope = { groupId: string; sessionId?: string };
type GroupResponse = { rows: GroupRow[] };

const document = { kind: 'Document', definitions: [] } as never;

describe('query scope registry reset contract', () => {
  it('keeps query freshness outside the TanStack cache after resetRuntime', async () => {
    const transport = createMockTransport({
      query: async <TData, TVariables>(operation: { variables?: TVariables }) => {
        const variables = operation.variables as GroupScope;
        return {
          data: {
            rows: [{ id: variables.sessionId ?? variables.groupId, groupId: variables.groupId, label: variables.groupId }]
          } as TData
        };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const groups = defineModelRuntime({
      id: 'SpecResetScopeRegistry',
      name: 'SpecResetScopeRegistry',
      fields: {
        groupId: f.str(),
        label: f.str()
      },
      scopes: {
        byGroup: ({ by: { groupId: 'groupId' } })
      }
    });
    const query = groups.query<GroupResponse, GroupScope, GroupScope, GroupRow>('byGroup', {
      document,
      vars: scopeValue => scopeValue,
      select: data => data.rows,
      into: groups.scopes.byGroup
    });

    await query.fetch({ groupId: 'account-A', sessionId: 'before-reset' });
    resetRuntime();
    configureDb({ storage: createMemoryPlane(), transport });
    query.invalidate({ groupId: 'account-A' });

    await query.fetch({ groupId: 'B', sessionId: 'after-reset' });
    query.invalidate({ groupId: 'B' });

    expect(transport.calls).toHaveLength(2);
  });
});
