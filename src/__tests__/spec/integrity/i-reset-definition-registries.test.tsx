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
  invalidateModel,
  registerModelInvalidation
} from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

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

  it('replaces the invalidation callback when the same definition registers again', () => {
    const calls: string[] = [];
    registerModelInvalidation('SpecResetInvalidation', 'probe-query', () => void calls.push('first'));
    registerModelInvalidation('SpecResetInvalidation', 'probe-query', () => void calls.push('second'));

    invalidateModel('SpecResetInvalidation');

    expect(calls).toEqual(['second']);
  });

  it('runs boot validations declared before a reset on the next boot', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    let ran = 0;
    registerBootValidation('reset-probe', () => {
      ran += 1;
    });

    act(() => {
      resetRuntime();
    });
    runBootValidations();

    expect(ran).toBe(1);
  });
});
