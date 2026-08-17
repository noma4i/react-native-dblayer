import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; value: string };
type Scope = { bucket: string };
type QueryResponse = { root: Row };

const queryDocument: TypedDocumentNode<QueryResponse, Scope> = { kind: Kind.DOCUMENT, definitions: [] };
const RowSchema = defineShape<Row>()({ value: f.str() });

/**
 * A write plan may only name a model this package declared. An object that merely looks like a model
 * (a plain object carrying `build`, a facade from a foreign package) is refused BEFORE any write of
 * the plan lands, so a typo in a plan target can never write rows into nothing or drop a landing
 * silently.
 */
describe('write-plan target identity', () => {
  let tag = 0;
  const setup = (write: (plan: { upsert: (target: never, row: never) => void }, sibling: unknown, suffix: number) => void) => {
    const suffix = (tag += 1);
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { root: { id: `root-${suffix}`, value: 'root' } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Sibling = defineModel(`SpecHandleGuardSibling${suffix}`, { schema: RowSchema });
    const Root = defineModel(`SpecHandleGuardRoot${suffix}`, {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(queryDocument, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => write(plan as never, Sibling, suffix)
          })
        }
      })
    });
    return { Root, Sibling, suffix };
  };

  it('writes through a declared model target and leaves both models readable', async () => {
    const { Root, Sibling, suffix } = setup((plan, sibling, id) => {
      plan.upsert(sibling as never, { id: `sibling-${id}`, value: 'planned' } as never);
    });

    await Root.root({ bucket: 'all' }).fetch();

    expect(Root.find(`root-${suffix}`)).toMatchObject({ id: `root-${suffix}`, value: 'root' });
    expect(Sibling.where({}).read().map(row => [row.id, row.value])).toEqual([[`sibling-${suffix}`, 'planned']]);
  });

  it('refuses an undeclared object that looks like a model and lands nothing from that response', async () => {
    const stranger = { build: () => ({ id: 'stranger-1', value: 'never' }) };
    const { Root, Sibling, suffix } = setup((plan, sibling, id) => {
      plan.upsert(sibling as never, { id: `sibling-${id}`, value: 'planned' } as never);
      plan.upsert(stranger as never, { id: 'stranger-1', value: 'never' } as never);
    });

    await expect(Root.root({ bucket: 'all' }).fetch()).rejects.toThrow('Unknown model handle');

    expect(Root.find(`root-${suffix}`)).toBeUndefined();
    expect(Sibling.where({}).read()).toEqual([]);
  });

  it('refuses a plan target that is not a model at all', async () => {
    const { Root, Sibling, suffix } = setup(plan => {
      plan.upsert({ notAModel: true } as never, { id: 'x', value: 'never' } as never);
    });

    await expect(Root.root({ bucket: 'all' }).fetch()).rejects.toThrow('WritePlan requires a valid model target');

    expect(Root.find(`root-${suffix}`)).toBeUndefined();
    expect(Sibling.where({}).read()).toEqual([]);
  });
});
