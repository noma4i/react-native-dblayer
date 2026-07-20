import { act } from 'react-test-renderer';
import { bootDb, configureDb, defineModel, f, resetRuntime } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

type Payload = { saveMessage: { id: string; text: string } };

const deferredMutation = () => {
  let resolve!: (value: { data: Payload }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ data: Payload }>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  const transport = createMockTransport({
    mutation: async <TData,>() => (await promise) as { data: TData }
  });
  return { transport, resolve: (data: Payload) => resolve({ data }), reject };
};

const createMessages = (transport: ReturnType<typeof createMockTransport>) => {
  configureDb({ storage: createMemoryPlane(), transport });
  const messages = defineModel({ id: 'SpecPendingMessages', name: 'SpecPendingMessages', fields: { text: f.str() } });
  let tempId: string | null = null;
  const create = messages.mutation<Payload, { text: string }, { id: string; text: string }, { id: string; text: string }>('create', {
    document,
    result: 'saveMessage',
    optimistic: {
      model: messages,
      failure: 'rollback',
      build: input => ({ id: '', text: input.text }),
      selectServerNode: data => data.saveMessage
    },
    onMutate: (_input, context) => {
      tempId = context.tempId;
    }
  });
  const patch = messages.mutation<Payload, { id: string; text: string }, { id: string; text: string }, never>('patch', {
    document,
    result: 'saveMessage',
    optimistic: { method: 'patch', model: messages, selectId: input => input.id, selectPatch: input => ({ text: input.text }) }
  });
  return { messages, create, patch, tempId: () => tempId };
};

describe('model pending flag', () => {
  // Performance scale guarantee: N/A because each hook tracks one operation id dependency.
  it('reports an optimistic insert until its temp row commits to a server id', async () => {
    const pending = deferredMutation();
    const { messages, create, tempId } = createMessages(pending.transport);
    let currentId: string | null = null;
    const tempReader = renderCounted(() => messages.use.pending(currentId));
    const serverReader = renderCounted(() => messages.use.pending('server-1'));

    const promise = create.run({ text: 'draft' });
    currentId = tempId();
    tempReader.unmount();
    const activeTempReader = renderCounted(() => messages.use.pending(currentId));
    expect(activeTempReader.result()).toBe(true);
    expect(serverReader.result()).toBe(false);

    await act(async () => {
      pending.resolve({ saveMessage: { id: 'server-1', text: 'saved' } });
      await promise;
    });

    expect(activeTempReader.result()).toBe(false);
    expect(serverReader.result()).toBe(false);
    expect(messages.get(currentId)).toBeUndefined();
    expect(messages.get('server-1')?.text).toBe('saved');
    activeTempReader.unmount();
    serverReader.unmount();
  });

  it('clears a pending optimistic insert when rollback removes the row', async () => {
    const pending = deferredMutation();
    const { messages, create, tempId } = createMessages(pending.transport);
    const promise = create.run({ text: 'draft' });
    const id = tempId();
    const reader = renderCounted(() => messages.use.pending(id));
    expect(reader.result()).toBe(true);

    await act(async () => {
      pending.reject(new Error('failed'));
      await expect(promise).rejects.toThrow('failed');
    });

    expect(reader.result()).toBe(false);
    expect(messages.get(id)).toBeUndefined();
    reader.unmount();
  });

  it.each(['commit', 'rollback'] as const)('tracks an optimistic patch through %s', async outcome => {
    const pending = deferredMutation();
    const { messages, patch } = createMessages(pending.transport);
    messages.insertStored({ id: 'message-1', text: 'before' });
    const reader = renderCounted(() => messages.use.pending('message-1'));
    let promise!: Promise<Payload | null>;
    act(() => {
      promise = patch.run({ id: 'message-1', text: 'during' });
    });
    expect(reader.result()).toBe(true);

    await act(async () => {
      if (outcome === 'commit') pending.resolve({ saveMessage: { id: 'message-1', text: 'during' } });
      else pending.reject(new Error('failed'));
      if (outcome === 'commit') await promise;
      else await expect(promise).rejects.toThrow('failed');
    });

    expect(reader.result()).toBe(false);
    expect(messages.get('message-1')?.text).toBe(outcome === 'commit' ? 'during' : 'before');
    reader.unmount();
  });

  it('notifies only the reader for the transitioning id', async () => {
    const pending = deferredMutation();
    const { messages, patch } = createMessages(pending.transport);
    messages.insertStored({ id: 'message-1', text: 'before' });
    messages.insertStored({ id: 'message-2', text: 'other' });
    const target = renderCounted(() => messages.use.pending('message-1'));
    const unrelated = renderCounted(() => messages.use.pending('message-2'));
    const targetBefore = target.renders();
    const unrelatedBefore = unrelated.renders();
    let promise!: Promise<Payload | null>;
    act(() => {
      promise = patch.run({ id: 'message-1', text: 'during' });
    });

    expect(target.renders() - targetBefore).toBe(1);
    expect(unrelated.renders() - unrelatedBefore).toBe(0);
    await act(async () => {
      pending.resolve({ saveMessage: { id: 'message-1', text: 'during' } });
      await promise;
    });
    expect(target.renders() - targetBefore).toBe(2);
    expect(unrelated.renders() - unrelatedBefore).toBe(0);
    target.unmount();
    unrelated.unmount();
  });

  it('returns false for nullish ids without reacting to operations', async () => {
    const pending = deferredMutation();
    const { messages, patch } = createMessages(pending.transport);
    messages.insertStored({ id: 'message-1', text: 'before' });
    const reader = renderCounted(() => messages.use.pending(null));
    const renders = reader.renders();
    const promise = patch.run({ id: 'message-1', text: 'during' });
    expect(reader.result()).toBe(false);
    expect(reader.renders()).toBe(renders);
    pending.resolve({ saveMessage: { id: 'message-1', text: 'during' } });
    await promise;
    reader.unmount();
  });

  it('clears pending state and live snapshots on reset', () => {
    const pending = deferredMutation();
    const { messages, patch } = createMessages(pending.transport);
    messages.insertStored({ id: 'message-1', text: 'before' });
    void patch.run({ id: 'message-1', text: 'during' });
    const reader = renderCounted(() => messages.use.pending('message-1'));
    expect(reader.result()).toBe(true);

    act(() => resetRuntime());

    expect(reader.result()).toBe(false);
    reader.unmount();
  });

  it('reconciles a hydrated pending operation to an absent row and false flag during boot', async () => {
    const storage = createMemoryPlane();
    storage.set([
      {
        key: 'dbl:ops',
        value: JSON.stringify({
          'operation-1': {
            operationId: 'operation-1',
            model: 'SpecPendingReplay',
            tempIds: ['temp-replay'],
            intent: 'insert',
            status: 'pending',
            idempotencyKey: 'operation-1',
            createdAt: 1
          }
        })
      }
    ]);
    configureDb({ storage, transport: createMockTransport() });
    const messages = defineModel({ id: 'SpecPendingReplay', name: 'SpecPendingReplay', fields: { text: f.str() } });

    await bootDb();
    const reader = renderCounted(() => messages.use.pending('temp-replay'));

    expect(reader.result()).toBe(false);
    expect(messages.get('temp-replay')).toBeUndefined();
    reader.unmount();
  });

  it('closes a hydrated patch operation without treating its existing row as an orphan temp row', async () => {
    const storage = createMemoryPlane();
    storage.set([
      {
        key: 'dbl:ops',
        value: JSON.stringify({
          'operation-1': {
            operationId: 'operation-1',
            model: 'SpecPendingPatchReplay',
            tempIds: [],
            rowIds: ['message-1'],
            intent: 'patch',
            status: 'pending',
            idempotencyKey: 'operation-1',
            createdAt: 1
          }
        })
      }
    ]);
    configureDb({ storage, transport: createMockTransport() });
    const messages = defineModel({ id: 'SpecPendingPatchReplay', name: 'SpecPendingPatchReplay', fields: { text: f.str() }, gc: 'exempt' });
    messages.insertStored({ id: 'message-1', text: 'kept' });

    await bootDb();
    const reader = renderCounted(() => messages.use.pending('message-1'));

    expect(reader.result()).toBe(false);
    expect(messages.get('message-1')?.text).toBe('kept');
    reader.unmount();
  });

  it('does not notify an unmounted pending reader', () => {
    const pending = deferredMutation();
    const { messages, patch } = createMessages(pending.transport);
    messages.insertStored({ id: 'message-1', text: 'before' });
    const reader = renderCounted(() => messages.use.pending('message-1'));
    const renders = reader.renders();
    reader.unmount();

    void patch.run({ id: 'message-1', text: 'during' });

    expect(reader.renders()).toBe(renders);
  });
});
