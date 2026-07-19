import { act } from 'react-test-renderer';
import { configureDb, defineModel, f, resetRuntime } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type Result = { status: 'processing' | 'ready' | 'failed' };

const settle = async () => {
  for (let tick = 0; tick < 4; tick += 1) await act(async () => Promise.resolve());
};

let pollerSequence = 0;
const createPoller = (fetch: (id: string) => Promise<Result>, maxAttempts = 3) => {
  const transport = createMockTransport({
    query: async operation => ({ data: (await fetch(String((operation.variables as Record<string, unknown> | undefined)?.id))) as never })
  });
  configureDb({ storage: createMemoryPlane(), transport });
  pollerSequence += 1;
  const model = defineModel({ id: `SpecStatusPoller${pollerSequence}`, name: `SpecStatusPoller${pollerSequence}`, fields: { status: f.str() } });
  return model.poller<Result>('status', {
    document: { kind: 'Document', definitions: [] } as never,
    apply: () => undefined,
    classify: result => (result.status === 'ready' ? 'ready' : result.status === 'failed' ? 'failed' : null),
    intervalMs: 5,
    maxAttempts
  });
};

describe('model status poller phases', () => {
  // Performance scale guarantee: N/A because each phase hook subscribes to one poller id.
  it.each(['ready', 'failed'] as const)('classifies a terminal payload as %s', async status => {
    jest.useFakeTimers();
    const poller = createPoller(async () => ({ status }));
    const detach = poller.attach('message-1');
    expect(poller.getPhase('message-1')).toEqual({ phase: 'polling', attempts: 1 });
    await settle();
    expect(poller.getPhase('message-1')).toEqual({ phase: status, reason: 'terminal-payload', attempts: 1 });
    detach();
    jest.useRealTimers();
  });

  it('reports stalled after exhausting the attempt budget', async () => {
    jest.useFakeTimers();
    const poller = createPoller(async () => ({ status: 'processing' }), 2);
    poller.attach('message-1');
    await settle();
    act(() => jest.advanceTimersByTime(5));
    await settle();
    expect(poller.getPhase('message-1')).toEqual({ phase: 'stalled', reason: 'budget-exhausted', attempts: 2 });
    jest.useRealTimers();
  });

  it('publishes attempts and phase changes only to the matching id hook', async () => {
    jest.useFakeTimers();
    const poller = createPoller(async () => ({ status: 'processing' }), 3);
    const target = renderCounted(() => poller.usePhase('message-1'));
    const unrelated = renderCounted(() => poller.usePhase('message-2'));
    const targetBefore = target.renders();
    const unrelatedBefore = unrelated.renders();
    poller.attach('message-1');
    await settle();

    expect(target.result()).toEqual({ phase: 'polling', attempts: 1 });
    expect(target.renders()).toBeGreaterThan(targetBefore);
    expect(unrelated.renders()).toBe(unrelatedBefore);
    target.unmount();
    unrelated.unmount();
    jest.useRealTimers();
  });

  it('keeps a phase snapshot stable when no phase or attempt changed', () => {
    const poller = createPoller(async () => ({ status: 'processing' }));
    const first = poller.getPhase('message-1');
    const second = poller.getPhase('message-1');
    expect(second).toBe(first);
  });

  it('dedupes overlapping refresh calls while exposing one attempt', async () => {
    let resolve!: (result: Result) => void;
    const fetch = jest.fn(() => new Promise<Result>(nextResolve => (resolve = nextResolve)));
    const poller = createPoller(fetch);
    const first = poller.refresh('message-1');
    const second = poller.refresh('message-1');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(poller.getPhase('message-1')).toEqual({ phase: 'polling', attempts: 1 });
    resolve({ status: 'ready' });
    await Promise.all([first, second]);
    expect(poller.getPhase('message-1')).toEqual({ phase: 'ready', reason: 'terminal-payload', attempts: 1 });
  });

  it('returns idle after detach and stops its timer', async () => {
    jest.useFakeTimers();
    const fetch = jest.fn(async () => ({ status: 'processing' as const }));
    const poller = createPoller(fetch);
    const detach = poller.attach('message-1');
    await settle();
    detach();
    const calls = fetch.mock.calls.length;
    expect(poller.getPhase('message-1')).toEqual({ phase: 'idle', reason: 'stopped', attempts: 1 });
    act(() => jest.advanceTimersByTime(50));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(calls);
    jest.useRealTimers();
  });

  it('resets an active phase to idle and fences transport completion and timers', async () => {
    jest.useFakeTimers();
    let resolve!: (result: Result) => void;
    const fetch = jest.fn(() => new Promise<Result>(nextResolve => (resolve = nextResolve)));
    const poller = createPoller(fetch);
    const reader = renderCounted(() => poller.usePhase('message-1'));
    poller.attach('message-1');
    expect(poller.getPhase('message-1').phase).toBe('polling');

    act(() => resetRuntime());
    expect(reader.result()).toEqual({ phase: 'idle', attempts: 0 });
    resolve({ status: 'ready' });
    await settle();
    act(() => jest.advanceTimersByTime(50));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(poller.getPhase('message-1')).toEqual({ phase: 'idle', attempts: 0 });
    reader.unmount();
    jest.useRealTimers();
  });
});
