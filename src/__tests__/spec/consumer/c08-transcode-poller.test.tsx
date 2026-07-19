import { act } from 'react-test-renderer';
import { configureDb, defineModel, f, resetRuntime } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type PollPayload = { transcodeMessage: { id: string; status: string; progress: number } };
type MessageRow = { id: string; status: string; progress: number };
type MessageModel = ReturnType<typeof createMessageModel>;

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const createMessageModel = (intervalMs: number, maxAttempts: number, transport: ReturnType<typeof createMockTransport>) => {
  const messages = defineModel({
    id: `SpecConsumerPoller${intervalMs}-${maxAttempts}`,
    name: `SpecConsumerPoller${intervalMs}-${maxAttempts}`,
    fields: {
      id: f.str(),
      status: f.str(),
      progress: f.num()
    },
    statics: model => {
      const poller = model.poller<PollPayload>('transcode', {
        document,
        vars: id => ({ id }),
        apply: (id, payload) => {
          if (payload.transcodeMessage.id !== id) return;
          model.patch(id, { status: payload.transcodeMessage.status, progress: payload.transcodeMessage.progress });
        },
        classify: payload => {
          if (payload.transcodeMessage.status === 'done') return 'ready';
          if (payload.transcodeMessage.status === 'failed') return 'failed';
          return null;
        },
        intervalMs,
        maxAttempts
      });
      return {
        transcode: { attach: poller.attach, refresh: poller.refresh, getPhase: poller.getPhase }
      };
    }
  });

  messages.insertStored({ id: 'message-1', status: 'init', progress: 0 });
  return messages;
};

describe('model status poller', () => {
  it('starts polling on attach and stops on terminal status with row updates on changes', async () => {
    jest.useFakeTimers();
    const responses = [
      { transcodeMessage: { id: 'message-1', status: 'queued', progress: 1 } },
      { transcodeMessage: { id: 'message-1', status: 'running', progress: 60 } },
      { transcodeMessage: { id: 'message-1', status: 'done', progress: 100 } }
    ];
    const transport = createMockTransport({
      query: async <TData,>() => {
        const response = responses.shift();
        if (!response) return { data: { transcodeMessage: { id: 'message-1', status: 'done', progress: 100 } } as TData };
        return { data: response as TData };
      }
    });

    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessageModel(5, 10, transport);
    const reader = renderCounted(() => messages.use.row('message-1') as MessageRow | undefined);
    const before = reader.renders();

    const detach = messages.transcode.attach('message-1');
    await settle();

    act(() => {
      jest.advanceTimersByTime(5);
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(5);
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(5);
    });
    await settle();

    expect(transport.calls).toHaveLength(3);
    expect(reader.result()?.status).toBe('done');
    expect(reader.renders() - before).toBe(3);
    expect(messages.transcode.getPhase('message-1').phase).toBe('ready');

    act(() => {
      jest.advanceTimersByTime(50);
    });
    await settle();
    expect(transport.calls).toHaveLength(3);

    detach();
    reader.unmount();
    jest.useRealTimers();
  });

  it('stops polling after budget is reached and keeps last non-terminal status', async () => {
    jest.useFakeTimers();
    const responses = [
      { transcodeMessage: { id: 'message-1', status: 'queued', progress: 1 } },
      { transcodeMessage: { id: 'message-1', status: 'running', progress: 20 } },
      { transcodeMessage: { id: 'message-1', status: 'running', progress: 30 } }
    ];
    const transport = createMockTransport({
      query: async <TData,>() => {
        const response = responses.shift();
        if (!response) return { data: { transcodeMessage: { id: 'message-1', status: 'running', progress: 30 } } as TData };
        return { data: response as TData };
      }
    });

    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessageModel(5, 2, transport);
    const reader = renderCounted(() => messages.use.row('message-1') as MessageRow | undefined);

    messages.transcode.attach('message-1');
    await settle();

    act(() => {
      jest.advanceTimersByTime(5);
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(5);
    });
    await settle();

    expect(messages.transcode.getPhase('message-1').phase).toBe('stalled');
    expect(transport.calls).toHaveLength(2);

    act(() => {
      jest.advanceTimersByTime(50);
    });
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect(reader.result()?.progress).toBe(20);
    expect(messages.transcode.getPhase('message-1').phase).toBe('stalled');

    reader.unmount();
    jest.useRealTimers();
  });

  it('dedupes overlapping refresh calls so only one in-flight fetch is active', async () => {
    let resolve!: (value: { data: PollPayload }) => void;
    const transport = createMockTransport({
      query: async <TData,>() =>
        new Promise<{ data: TData }>(promiseResolve => {
          resolve = promiseResolve as (value: { data: PollPayload }) => void;
        })
    });

    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessageModel(10, 5, transport);
    const reader = renderCounted(() => messages.use.row('message-1') as MessageRow | undefined);

    const refreshA = messages.transcode.refresh('message-1');
    const refreshB = messages.transcode.refresh('message-1');
    expect(transport.calls).toHaveLength(1);

    resolve({ data: { transcodeMessage: { id: 'message-1', status: 'done', progress: 100 } } });
    await Promise.all([refreshA, refreshB]);
    await settle();

    expect(reader.result()?.status).toBe('done');
    expect(reader.renders()).toBeGreaterThanOrEqual(2);
    reader.unmount();
  });

  it('stops applying and polling after runtime reset with generation fence', async () => {
    jest.useFakeTimers();
    let resolve!: (value: { data: PollPayload }) => void;
    const transport = createMockTransport({
      query: async <TData,>() =>
        new Promise<{ data: TData }>(promiseResolve => {
          resolve = promiseResolve as (value: { data: PollPayload }) => void;
        })
    });

    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessageModel(5, 5, transport);
    const reader = renderCounted(() => messages.use.row('message-1') as MessageRow | undefined);

    messages.transcode.attach('message-1');
    await settle();

    act(() => {
      resetRuntime();
    });
    resolve({ data: { transcodeMessage: { id: 'message-1', status: 'running', progress: 20 } } });
    await settle();

    act(() => {
      jest.advanceTimersByTime(50);
    });
    await settle();

    expect(reader.result()).toBeUndefined();
    expect(transport.calls).toHaveLength(1);
    expect(messages.transcode.getPhase('message-1')).toEqual({ phase: 'idle', attempts: 0 });

    reader.unmount();
    jest.useRealTimers();
  });
});
