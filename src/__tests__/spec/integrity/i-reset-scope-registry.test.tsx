import { configureDb, defineModel, f, resetRuntime, scope } from '../../../index';
import { getDbRuntimeConfig } from '../../../dsl/configure';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type GroupRow = { id: string; groupId: string; label: string };
type GroupScope = { groupId: string; sessionId?: string };
type GroupResponse = { rows: GroupRow[] };

const document = { kind: 'Document', definitions: [] } as never;

describe('query scope registry reset contract', () => {
  it('invalidates only scopes registered after resetRuntime', async () => {
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
    const groups = defineModel({
      id: 'SpecResetScopeRegistry',
      name: 'SpecResetScopeRegistry',
      fields: {
        groupId: f.str(),
        label: f.str()
      },
      scopes: {
        byGroup: scope<GroupRow>({ by: { groupId: 'groupId' } })
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
    const invalidateQueries = jest.spyOn(getDbRuntimeConfig().queryClient, 'invalidateQueries');

    query.invalidate({ groupId: 'account-A' });

    expect(
      invalidateQueries.mock.calls.some(([filters]) => {
        const scopeKey = filters?.queryKey?.[2];
        return typeof scopeKey === 'string' && scopeKey.includes('"groupId":"account-A"') && scopeKey.includes('"sessionId":"before-reset"');
      })
    ).toBe(false);

    await query.fetch({ groupId: 'B', sessionId: 'after-reset' });
    query.invalidate({ groupId: 'B' });

    expect(
      invalidateQueries.mock.calls.some(([filters]) => {
        const scopeKey = filters?.queryKey?.[2];
        return typeof scopeKey === 'string' && scopeKey.includes('"groupId":"B"') && scopeKey.includes('"sessionId":"after-reset"');
      })
    ).toBe(true);
  });
});
