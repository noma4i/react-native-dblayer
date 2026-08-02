import { configureDb, defineModel, defineModelRuntime, defineShape, f, getCommitBus, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

type Row = { id: string; value: string };
type EventPayload = { root: Row; sibling: Row };

const RowSchema = defineShape<Row>()({ value: f.str() });

describe('ingest write plan safety', () => {
  it('commits root and sibling rows in one commit wave', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Root = defineModelRuntime({ id: 'SpecIngestWritePlanAtomicRoot', name: 'SpecIngestWritePlanAtomicRoot', fields: { value: f.str() } });
    const Sibling = defineModel('SpecIngestWritePlanAtomicSibling', { schema: RowSchema });
    const payload: EventPayload = {
      root: { id: 'root-1', value: 'root' },
      sibling: { id: 'sibling-1', value: 'sibling' }
    };
    const before = diagnostics().snapshot().commits;
    const ingest = Root.ingest({
      response: {
        handler: data => {
          const event = data as EventPayload;
          return {
            upsert: event.root,
            write: ({ data: received }, plan) => {
              expect(received).toBe(payload);
              plan.upsert(Sibling, (received as EventPayload).sibling);
            }
          };
        }
      }
    });

    ingest.apply('response', payload);

    expect(Root.find('root-1')).toEqual(payload.root);
    expect(Sibling.find('sibling-1')).toEqual(payload.sibling);
    expect(diagnostics().snapshot().commits - before).toBe(1);
  });

  it('resurrects a tombstoned sibling from an ingest event write', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Root = defineModelRuntime({ id: 'SpecIngestWritePlanEventOriginRoot', name: 'SpecIngestWritePlanEventOriginRoot', fields: { value: f.str() } });
    const Sibling = defineModel('SpecIngestWritePlanEventOriginSibling', { schema: RowSchema });
    const siblingId = 'sibling-resurrect-1';
    Sibling.insert({ id: siblingId, value: 'local' });
    Sibling.destroy(siblingId);
    expect(Sibling.find(siblingId)).toBeUndefined();

    const payload: EventPayload = {
      root: { id: 'root-resurrect-1', value: 'root' },
      sibling: { id: siblingId, value: 'authoritative-server' }
    };
    const ingest = Root.ingest({
      response: {
        handler: () => ({
          write: ({ data: received }, plan) => {
            plan.upsert(Sibling, (received as EventPayload).sibling);
          }
        })
      }
    });

    ingest.apply('response', payload);

    expect(Sibling.find(siblingId)).toEqual(payload.sibling);
  });

  it('leaves root and sibling unchanged when write throws', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Root = defineModelRuntime({ id: 'SpecIngestWritePlanThrowRoot', name: 'SpecIngestWritePlanThrowRoot', fields: { value: f.str() } });
    const Sibling = defineModel('SpecIngestWritePlanThrowSibling', { schema: RowSchema });
    const ingest = Root.ingest({
      response: {
        handler: payload => ({
          upsert: (payload as EventPayload).root,
          write: (_context, plan) => {
            plan.upsert(Sibling, (payload as EventPayload).sibling);
            throw new Error('ingest write failed');
          }
        })
      }
    });

    ingest.apply('response', { root: { id: 'root-2', value: 'root' }, sibling: { id: 'sibling-2', value: 'sibling' } });
    expect(Root.find('root-2')).toBeUndefined();
    expect(Sibling.find('sibling-2')).toBeUndefined();
  });

  it('skips invalidation when write resets the runtime', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Root = defineModelRuntime({ id: 'SpecIngestWritePlanResetRoot', name: 'SpecIngestWritePlanResetRoot', fields: { value: f.str() } });
    const Sibling = defineModel('SpecIngestWritePlanResetSibling', { schema: RowSchema });
    let invalidations = 0;
    const rootInvalidate = jest.spyOn(Root, 'invalidate');
    const target = { invalidate: () => invalidations++ };
    const ingest = Root.ingest({
      response: {
        handler: payload => ({
          upsert: (payload as EventPayload).root,
          invalidate: {},
          write: (_context, plan) => {
            plan.upsert(Sibling, (payload as EventPayload).sibling);
            plan.invalidate(target);
            resetRuntime();
          }
        })
      }
    });

    ingest.apply('response', { root: { id: 'root-3', value: 'root' }, sibling: { id: 'sibling-3', value: 'sibling' } });
    expect(Root.find('root-3')).toBeUndefined();
    expect(Sibling.find('sibling-3')).toBeUndefined();
    expect(invalidations).toBe(0);
    expect(rootInvalidate).not.toHaveBeenCalled();
  });

  it('skips plan and root invalidation after a commit subscriber resets the runtime', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Root = defineModelRuntime({ id: 'SpecIngestWritePlanCommitResetRoot', name: 'SpecIngestWritePlanCommitResetRoot', fields: { value: f.str() } });
    const Sibling = defineModel('SpecIngestWritePlanCommitResetSibling', { schema: RowSchema });
    let planInvalidations = 0;
    const rootInvalidate = jest.spyOn(Root, 'invalidate');
    const target = { invalidate: () => planInvalidations++ };
    const unsubscribe = getCommitBus().subscribeAll(() => resetRuntime());
    const ingest = Root.ingest({
      response: {
        handler: payload => ({
          upsert: (payload as EventPayload).root,
          invalidate: {},
          write: (_context, plan) => {
            plan.upsert(Sibling, (payload as EventPayload).sibling);
            plan.invalidate(target);
          }
        })
      }
    });

    try {
      ingest.apply('response', { root: { id: 'root-4', value: 'root' }, sibling: { id: 'sibling-4', value: 'sibling' } });
    } finally {
      unsubscribe();
    }

    expect(planInvalidations).toBe(0);
    expect(rootInvalidate).not.toHaveBeenCalled();
  });

  it('rejects a forged target without committing the root', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Root = defineModelRuntime({ id: 'SpecIngestWritePlanForgedRoot', name: 'SpecIngestWritePlanForgedRoot', fields: { value: f.str() } });
    const Victim = defineModel('SpecIngestWritePlanForgedVictim', { schema: RowSchema });
    Victim.insert({ id: 'victim-1', value: 'before' });
    const forgedTarget = { key: Victim.key, build: Victim.build };
    const ingest = Root.ingest({
      response: {
        handler: payload => ({
          upsert: (payload as EventPayload).root,
          write: (_context, plan) => plan.update(forgedTarget, 'victim-1', { value: 'forged' })
        })
      }
    });

    ingest.apply('response', { root: { id: 'root-5', value: 'root' }, sibling: { id: 'unused', value: 'unused' } });
    expect(Victim.find('victim-1')).toEqual({ id: 'victim-1', value: 'before' });
    expect(Root.find('root-5')).toBeUndefined();
  });
});
