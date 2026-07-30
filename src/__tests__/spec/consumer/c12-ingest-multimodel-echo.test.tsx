import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineModelRuntime, f, type DbTransport } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type PrimaryRow = { id: string; uuid: string; status: string };
type SecondaryRow = { id: string; primaryId: string; label: string };
type EventPayload = { primary: PrimaryRow; secondary: SecondaryRow };
type OperationPayload = { operationId?: string; primary: PrimaryRow; secondary: SecondaryRow };
type MutationInput = { id: string; uuid: string; status: string; operationId: string };
type MutationResult = { momentIngest: PrimaryRow };
type ScopeValue = { uuid: string };

const document = { kind: 'Document', definitions: [] } as never;

const createPrimaryModel = () =>
  defineModelRuntime({
    id: 'SpecConsumerIngestPrimary',
    name: 'SpecConsumerIngestPrimary',
    fields: {
      id: f.str(),
      uuid: f.str(),
      status: f.str()
    },
    scopes: {
      byUuid: ({ by: { uuid: 'uuid' } })
    },
    relations: () => ({})
  });

const createSecondaryModel = () =>
  defineModelRuntime({
    id: 'SpecConsumerIngestSecondary',
    name: 'SpecConsumerIngestSecondary',
    fields: {
      id: f.str(),
      primaryId: f.str(),
      label: f.str()
    },
    scopes: {
      byPrimary: ({ by: { primaryId: 'primaryId' } })
    },
    relations: () => ({})
  });

const createUnrelatedModel = () =>
  defineModelRuntime({
    id: 'SpecConsumerIngestUnrelated',
    name: 'SpecConsumerIngestUnrelated',
    fields: {
      id: f.str(),
      bucket: f.str(),
      value: f.str()
    },
    scopes: {
      byBucket: ({ by: { bucket: 'bucket' } })
    },
    relations: () => ({})
  });

describe('multi-model ingest and ingest echo contracts', () => {
  it('invalidates only the matching active query scope from an ingest declaration', async () => {
    const fetches: Record<string, number> = { 'uuid-a': 0, 'uuid-b': 0 };
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) => {
        const uuid = ((operation.variables ?? {}) as ScopeValue).uuid;
        fetches[uuid] += 1;
        return { data: { primary: [{ id: uuid, uuid, status: 'ready' }] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const primary = createPrimaryModel();
    const query = primary.query<{ primary: PrimaryRow[] }, ScopeValue, ScopeValue, PrimaryRow>('ingest-scope', {
      document,
      vars: value => value,
      select: data => data.primary,
      into: primary.scopes.byUuid
    });
    const ingest = primary.ingest({
      scoped: { handler: () => ({ invalidate: { uuid: 'uuid-a' } }) },
      full: { handler: () => ({ invalidateAll: true }) },
      ignored: { handler: () => ({}) }
    });
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = () => {
      query.use({ uuid: 'uuid-a' });
      query.use({ uuid: 'uuid-b' });
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(fetches).toEqual({ 'uuid-a': 1, 'uuid-b': 1 });

    act(() => {
      ingest.apply('scoped', {});
    });
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(fetches).toEqual({ 'uuid-a': 2, 'uuid-b': 1 });

    act(() => {
      ingest.apply('full', {});
    });
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(fetches).toEqual({ 'uuid-a': 3, 'uuid-b': 2 });

    act(() => {
      ingest.apply('ignored', {});
    });
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(fetches).toEqual({ 'uuid-a': 3, 'uuid-b': 2 });
    act(() => root.unmount());
  });

  it('applies two-model extracts in one commit wave and does not touch unrelated scopes', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const primary = createPrimaryModel();
    const secondary = createSecondaryModel();
    const unrelated = createUnrelatedModel();
    unrelated.insert({ id: 'u-1', bucket: 'noise', value: 'unrelated' });

    const ingest = primary.ingest({
      momentIngest: {
        handler: payload => {
          const input = payload as EventPayload;
          return {
            upsert: input.primary,
            extract: [{ into: secondary, rows: [input.secondary] }]
          };
        }
      }
    });

    const primaryReader = renderCounted(() => primary.scopes.byUuid.use({ uuid: 'uuid-1' }));
    const secondaryReader = renderCounted(() => secondary.scopes.byPrimary.use({ primaryId: 'p-1' }));
    const unrelatedReader = renderCounted(() => unrelated.scopes.byBucket.use({ bucket: 'noise' }));
    const primaryBefore = primaryReader.renders();
    const secondaryBefore = secondaryReader.renders();
    const unrelatedBefore = unrelatedReader.renders();

    act(() => {
      ingest.apply('momentIngest', {
        primary: { id: 'p-1', uuid: 'uuid-1', status: 'ready' },
        secondary: { id: 's-1', primaryId: 'p-1', label: 'child-a' }
      });
    });

    expect(primaryReader.result().map(row => row.id)).toEqual(['p-1']);
    expect(secondaryReader.result().map(row => row.id)).toEqual(['s-1']);
    expect(primaryReader.renders() - primaryBefore).toBe(1);
    expect(secondaryReader.renders() - secondaryBefore).toBe(1);
    expect(unrelatedReader.renders() - unrelatedBefore).toBe(0);
    expect(unrelated.find('u-1')?.value).toBe('unrelated');

    primaryReader.unmount();
    secondaryReader.unmount();
    unrelatedReader.unmount();
  });

  it('skips event application when operationId is already committed by a mutation', async () => {
    const committedOperationId = 'c12-operation-1';
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        return { data: { momentIngest: { id: 'p-1', uuid: 'uuid-1', status: 'mutated' } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const primary = createPrimaryModel();
    const mutation = primary.mutation<MutationResult, MutationInput, PrimaryRow, PrimaryRow>('momentMutation', {
      document,
      result: 'momentIngest',
      dedupe: { key: input => input.operationId },
      once: true,
      mapInput: input => input,
      extract: ({ data }) => [{ into: primary, rows: [data.momentIngest] }]
    });

    const ingest = primary.ingest({
      momentIngest: {
        handler: payload => {
          const input = payload as OperationPayload;
          return { upsert: input.primary, operationId: input.operationId };
        }
      }
    });

    primary.insert({ id: 'p-1', uuid: 'uuid-1', status: 'initial' });
    const primaryReader = renderCounted(() => primary.scopes.byUuid.use({ uuid: 'uuid-1' }));
    const before = primaryReader.renders();

    await mutation.run({ id: 'p-1', uuid: 'uuid-1', status: 'mutated', operationId: committedOperationId });

    act(() => {
      ingest.apply('momentIngest', {
        operationId: committedOperationId,
        primary: { id: 'p-1', uuid: 'uuid-1', status: 'echo-attempt' },
        secondary: { id: 's-echo', primaryId: 'p-1', label: 'ignored' }
      } as never);
    });

    expect(primary.find('p-1')?.status).toBe('mutated');
    expect(primaryReader.renders() - before).toBe(0);

    primaryReader.unmount();
  });

  it('keeps the same event idempotent across duplicate payload deliveries', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const primary = createPrimaryModel();
    const payload = { id: 'p-1', uuid: 'uuid-1', status: 'ready' };
    const primaryReader = renderCounted(() => primary.scopes.byUuid.use({ uuid: 'uuid-1' }));
    const before = primaryReader.renders();

    const ingest = primary.ingest({
      momentIngest: {
        handler: () => ({ upsert: payload })
      }
    });

    act(() => {
      ingest.apply('momentIngest', { primary: payload, secondary: { id: 's-1', primaryId: 'p-1', label: 'child' } });
      ingest.apply('momentIngest', { primary: payload, secondary: { id: 's-1', primaryId: 'p-1', label: 'child' } });
    });

    expect(primaryReader.result().map(row => row.id)).toEqual(['p-1']);
    expect(primaryReader.renders() - before).toBe(1);
    expect(primary.find('p-1')?.status).toBe('ready');

    primaryReader.unmount();
  });
});
