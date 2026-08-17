import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import {
  configureDb,
  defineModel,
  defineShape,
  f,
  resetRuntime,
  registerBootValidation,
  runBootValidations,
  setFetchNetworkOnline,
  invalidateModel
} from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, settle } from '../helpers/harness';

type ResetData = { ok: boolean };
type ResetVariables = Record<string, never>;
type ResetRow = { id: string; ok: boolean };

const resetDocument: TypedDocumentNode<ResetData, ResetVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const ResetSchema = defineShape<ResetRow>()({ ok: f.bool() });

/**
 * Definitions (fetch/query handles, subscription-effect channels, boot validations) are created
 * once at app-module load and OUTLIVE `resetRuntime`. Definition registries therefore survive the
 * kill-switch, while per-definition MUTABLE state (offline pause) belongs to one runtime
 * generation and must not leak into the next.
 */
describe('reset and definition registries', () => {
  it('starts the next generation unpaused after an offline pause and a reset', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async () => { throw new Error('offline'); } })
    });
    const ResetModel = defineModel('SpecResetPauseProbe', {
      schema: ResetSchema,
      relations: owner => ({
        result: {
          remote: owner.gql.single(resetDocument, {
            variables: () => ({}),
            select: data => ({ id: 'reset-pause-probe', ok: data.ok })
          })
        }
      })
    });
    const relation = ResetModel.result({});
    setFetchNetworkOnline(false);
    await expect(relation.fetch()).rejects.toThrow('offline');
    const paused = renderCounted(() => relation.use({ enabled: false }));
    expect(paused.result().loadingState.isOffline).toBe(true);
    paused.unmount();

    setFetchNetworkOnline(true);
    act(() => {
      resetRuntime();
    });
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });

    const reader = renderCounted(() => relation.use({ enabled: false }));
    expect(reader.result().loadingState.isOffline).toBe(false);
    reader.unmount();
  });

  it('invalidates a model through the declaration that registered last', async () => {
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        return { data: { ok: served % 2 === 1 } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const InvalidationModel = defineModel('SpecResetInvalidation', {
      schema: ResetSchema,
      relations: owner => ({
        result: {
          remote: owner.gql.single(resetDocument, {
            variables: () => ({}),
            select: data => ({ id: 'invalidation-probe', ok: data.ok })
          })
        }
      })
    });
    const relation = InvalidationModel.result({});
    const reader = renderCounted(() => relation.use());
    await settle();
    expect(transport.calls).toHaveLength(1);
    expect(reader.result().data).toEqual({ id: 'invalidation-probe', ok: true });

    // Invalidating the model reaches the live declaration: it refetches and the reader serves the new value.
    act(() => {
      invalidateModel('SpecResetInvalidation');
    });
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect(reader.result().data).toEqual({ id: 'invalidation-probe', ok: false });
    reader.unmount();
  });

  it('[A7] runs boot validations declared before a reset on the next boot', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    registerBootValidation('reset-probe', () => {
      throw new Error('reset-probe rejected this declaration');
    });

    act(() => {
      resetRuntime();
    });

    // The declaration outlives the reset, so its verdict still reaches the next boot.
    expect(() => runBootValidations()).toThrow('reset-probe rejected this declaration');
  });
});
