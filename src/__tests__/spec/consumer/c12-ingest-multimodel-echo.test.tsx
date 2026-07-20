import { act } from 'react-test-renderer';
import { configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type PrimaryRow = { id: string; uuid: string; status: string };
type SecondaryRow = { id: string; primaryId: string; label: string };
type UnrelatedRow = { id: string; bucket: string; value: string };
type EventPayload = { primary: PrimaryRow; secondary: SecondaryRow };
type OperationPayload = { operationId?: string; primary: PrimaryRow; secondary: SecondaryRow };
type MutationInput = { id: string; uuid: string; status: string; operationId: string };
type MutationResult = { momentIngest: PrimaryRow };

const document = { kind: 'Document', definitions: [] } as never;

const createPrimaryModel = () =>
  defineModel({
    id: 'SpecConsumerIngestPrimary',
    name: 'SpecConsumerIngestPrimary',
    fields: {
      id: f.str(),
      uuid: f.str(),
      status: f.str()
    },
    scopes: {
      byUuid: scope<PrimaryRow>({ by: { uuid: 'uuid' } })
    },
    relations: () => ({})
  });

const createSecondaryModel = () =>
  defineModel({
    id: 'SpecConsumerIngestSecondary',
    name: 'SpecConsumerIngestSecondary',
    fields: {
      id: f.str(),
      primaryId: f.str(),
      label: f.str()
    },
    scopes: {
      byPrimary: scope<SecondaryRow>({ by: { primaryId: 'primaryId' } })
    },
    relations: () => ({})
  });

const createUnrelatedModel = () =>
  defineModel({
    id: 'SpecConsumerIngestUnrelated',
    name: 'SpecConsumerIngestUnrelated',
    fields: {
      id: f.str(),
      bucket: f.str(),
      value: f.str()
    },
    scopes: {
      byBucket: scope<UnrelatedRow>({ by: { bucket: 'bucket' } })
    },
    relations: () => ({})
  });

describe('multi-model ingest and ingest echo contracts', () => {
  it('applies two-model extracts in one commit wave and does not touch unrelated scopes', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const primary = createPrimaryModel();
    const secondary = createSecondaryModel();
    const unrelated = createUnrelatedModel();
    unrelated.insertStored({ id: 'u-1', bucket: 'noise', value: 'unrelated' });

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
    expect(unrelated.get('u-1')?.value).toBe('unrelated');

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

    primary.insertStored({ id: 'p-1', uuid: 'uuid-1', status: 'initial' });
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

    expect(primary.get('p-1')?.status).toBe('mutated');
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
    expect(primary.get('p-1')?.status).toBe('ready');

    primaryReader.unmount();
  });
});
