import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineShape, f, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; label: string; status: 'pending' | 'done' };
type Input = { label: string };
type Variables = { input: Input };
type Data = { createRow: { row: Row } };

const RowSchema = defineShape<Row>()({
  label: f.str(),
  status: f.enum(['pending', 'done'] as const)
});
const document: TypedDocumentNode<Data, Variables> = { kind: Kind.DOCUMENT, definitions: [] };

const defineRows = (key: string) =>
  defineModel(key, {
    schema: RowSchema,
    maintenance: { dropTempRowsAfterMs: 60_000 },
    actions: owner => ({
      create: owner.gql.action(document, {
        mode: 'request',
        result: 'createRow',
        variables: (input: Input) => ({ input }),
        optimistic: {
          root: {
            insert: {
              select: ({ input, tempId }) => ({ id: tempId, label: input.label, status: 'pending' as const })
            }
          }
        },
        root: { insert: { select: ({ data }) => data.createRow.row } }
      })
    })
  });

afterEach(resetRuntime);

describe('action failure contract', () => {
  it('rejects GraphQL errors even when the response also contains data', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => ({
            data: { createRow: { row: { id: 'server-1', label: 'server', status: 'done' } } } as TData,
            errors: [{ message: 'rejected' }]
          })
      })
    });
    const rows = defineRows('SpecActionFailureGraphqlError');

    await expect(rows.actions.create.run({ label: 'local' })).rejects.toThrow('rejected');

    expect(rows.find('server-1')).toBeUndefined();
    expect(rows.operation(rows.where({}).read()[0]?.id).read()).toMatchObject({ failed: true });
  });

  it('accepts an empty GraphQL error array', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => ({
            data: { createRow: { row: { id: 'server-1', label: 'server', status: 'done' } } } as TData,
            errors: []
          })
      })
    });
    const rows = defineRows('SpecActionFailureEmptyErrors');

    await rows.actions.create.run({ label: 'local' });

    expect(rows.where({}).read()).toEqual([{ id: 'server-1', label: 'server', status: 'done' }]);
  });

  it('rejects an optimistic insert model without temp-row retention', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });

    expect(() =>
      defineModel('SpecActionFailureMissingRetention', {
        schema: RowSchema,
        actions: owner => ({
          create: owner.gql.action(document, {
            mode: 'request',
            result: 'createRow',
            variables: (input: Input) => ({ input }),
            optimistic: {
              root: {
                insert: {
                  select: ({ input, tempId }) => ({ id: tempId, label: input.label, status: 'pending' as const })
                }
              }
            },
            root: { insert: { select: ({ data }) => data.createRow.row } }
          })
        })
      })
    ).toThrow('dropTempRowsAfterMs');
  });
});
