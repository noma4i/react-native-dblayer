import {
  belongsTo,
  configureDb,
  createDbSubscriptionEffects,
  defineIngest,
  defineModel,
  defineModelRuntime,
  defineModelIngest,
  defineShape,
  f,
  getOperationState,
  registerMutationCorrelator,
  type ModelIngestTools
} from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

describe('model ingest edge helpers', () => {
  it('covers payload ids, guards, effects, custom tools, destroy, upsert, and handler delivery', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const effects = createDbSubscriptionEffects({
      ingestBeforeEdge: (_payload: unknown) => undefined,
      ingestAfterEdge: (_payload: unknown) => undefined
    });
    const seen: string[] = [];
    effects.configure({
      ingestBeforeEdge: () => {
        seen.push('before');
      },
      ingestAfterEdge: () => {
        seen.push('after');
      }
    });
    const rows = defineModelRuntime({
      id: 'ModelIngestEdgeRows',
      name: 'ModelIngestEdgeRows',
      fields: { label: f.str() }
    });
    const sibling = defineModelRuntime({
      id: 'ModelIngestEdgeSibling',
      name: 'ModelIngestEdgeSibling',
      fields: { label: f.str() }
    });
    rows.insertMany([
      { id: 'string-id', label: 'string' },
      { id: '7', label: 'number' },
      { id: 'object-id', label: 'object' },
      { id: '8', label: 'object-number' },
      { id: 'destroy-id', label: 'destroy' }
    ]);
    const invalidate = jest.spyOn(rows, 'invalidate');
    const compiled = defineModelIngest(rows, {
      echo: { document, echoGuard: () => true },
      existingString: { document, guard: 'existing', apply: () => seen.push('existing-string') },
      existingNumber: { document, guard: 'existing', apply: () => seen.push('existing-number') },
      existingObject: { document, guard: 'existing', apply: () => seen.push('existing-object') },
      existingObjectNumber: { document, guard: 'existing', apply: () => seen.push('existing-object-number') },
      missingExisting: { document, guard: 'existing', apply: () => seen.push('missing') },
      functionGuard: { document, guard: () => false, apply: () => seen.push('guarded') },
      before: { document, effect: { name: 'ingestBeforeEdge', when: 'before' }, apply: () => seen.push('apply-before') },
      after: { document, effect: { name: 'ingestAfterEdge', when: 'after' }, apply: () => seen.push('apply-after') },
      unknownEffect: { document, effect: { name: 'missingIngestEffect', when: 'before' } },
      custom: {
        document,
        apply: (_payload: unknown, tools: ModelIngestTools) => {
          tools.invalidate();
          expect(tools.operations).toBe(getOperationState());
          expect(tools.models.ModelIngestEdgeSibling).toBe(sibling);
          seen.push('custom');
        }
      },
      destroy: { document, apply: 'destroy' },
      destroyMany: { document, handler: (payload: unknown) => ({ destroy: payload as string[] }) },
      upsert: { document },
      handler: { document, handler: (payload: unknown) => ({ upsert: payload }) }
    } as never);

    compiled.apply('echo', {});
    compiled.apply('existingString', 'string-id');
    compiled.apply('existingNumber', 7);
    compiled.apply('existingObject', { id: 'object-id' });
    compiled.apply('existingObjectNumber', { id: 8 });
    compiled.apply('missingExisting', null);
    compiled.apply('functionGuard', {});
    compiled.apply('before', {});
    compiled.apply('after', {});
    compiled.apply('unknownEffect', {});
    compiled.apply('custom', {});
    compiled.apply('destroy', null);
    compiled.apply('destroy', 'destroy-id');
    rows.insertMany([
      { id: 'destroy-many-1', label: 'destroy many one' },
      { id: 'destroy-many-2', label: 'destroy many two' }
    ]);
    compiled.apply('destroyMany', ['destroy-many-1', 'destroy-many-2']);
    compiled.apply('upsert', { id: 'upsert-id', label: 'upsert' });
    compiled.apply('handler', { id: 'handler-id', label: 'handler' });
    compiled.apply('missing-key', {});

    expect(seen).toEqual([
      'existing-string',
      'existing-number',
      'existing-object',
      'existing-object-number',
      'before',
      'apply-before',
      'apply-after',
      'after',
      'custom'
    ]);
    expect(invalidate).toHaveBeenCalled();
    expect(rows.find('destroy-id')).toBeUndefined();
    expect(rows.find('destroy-many-1')).toBeUndefined();
    expect(rows.find('destroy-many-2')).toBeUndefined();
    expect(rows.find('upsert-id')).toMatchObject({ label: 'upsert' });
    expect(rows.find('handler-id')).toMatchObject({ label: 'handler' });
    expect(compiled.entries).toHaveLength(15);

    const parents = defineModel('BaseIngestEdgeParents', {
      schema: defineShape<{ id: string; childCount: number }>()({ childCount: f.num() })
    });
    const children = defineModel('BaseIngestEdgeChildren', {
      schema: defineShape<{ id: string; parentId: string }>()({ parentId: f.str() }),
      associations: () => ({
        parent: belongsTo(parents, { foreignKey: 'parentId', counterCache: { field: 'childCount' } })
      })
    });
    parents.insert({ id: 'parent-1', childCount: 0 });
    const writing = defineIngest(rows, {
      relation: () => ({
        write: ({ data }, plan) => {
          const payload = data as { parentId: string };
          plan.upsert(children, { id: 'child-1', parentId: payload.parentId });
        }
      })
    });
    writing.apply('relation', { parentId: 'parent-1' });
    expect(children.find('child-1')).toMatchObject({ parentId: 'parent-1' });
    expect(parents.find('parent-1')).toMatchObject({ childCount: 1 });

    registerMutationCorrelator(children.key, 'write-child', { fields: ['parentId'] });
    children.insert({ id: 'temp-write-child', parentId: 'parent-1' });
    getOperationState().begin({
      operationId: 'write-child-operation',
      model: children.key,
      tempIds: ['temp-write-child'],
      rowIds: ['temp-write-child'],
      intent: 'insert',
      createdAt: 1
    });
    const correlatedWrite = defineIngest(rows, {
      relation: () => ({
        write: ({ data }, plan) => {
          const payload = data as { parentId: string };
          plan.upsert(children, { id: 'server-write-child', parentId: payload.parentId });
        }
      })
    });
    correlatedWrite.apply('relation', { parentId: 'parent-1' });
    expect(children.find('temp-write-child')).toBeUndefined();
    expect(children.find('server-write-child')).toMatchObject({ parentId: 'parent-1' });
  });

  it('returns null for absent declarations and reports handler failures', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'BaseIngestEdgeRows',
      name: 'BaseIngestEdgeRows',
      fields: { label: f.str() }
    });
    const ingest = defineIngest(rows, {
      empty: () => null,
      failure: () => {
        throw new Error('ingest failure');
      }
    });
    diagnostics().reset();

    expect(ingest.apply('missing', {})).toBeNull();
    expect(ingest.apply('empty', {})).toBeNull();
    expect(ingest.apply('failure', {})).toBeNull();
    expect(diagnostics().snapshot().ingestFailed).toBe(1);
  });
});
