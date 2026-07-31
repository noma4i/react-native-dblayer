import React, { act } from 'react';
import { AppState } from 'react-native';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineFetch } from '../../testApi';
import { createMemoryPlane, createMockTransport, setTestNetworkOnline, settle } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

type FetchResponse = { value: string };

/**
 * Foreground resume combined with a dead network: the resume drain must not fire transport calls
 * while offline, must not lose the staleness it detected, and reconnecting must deliver exactly
 * the refetch the offline resume owed - the two states compose instead of cancelling each other.
 */
describe('foreground resume while offline', () => {
  let appStateHandler: ((state: string) => void) | undefined;

  beforeEach(() => {
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, handler: (state: string) => void) => {
      appStateHandler = handler;
      return { remove: jest.fn() };
    }) as never);
  });

  afterEach(() => {
    setTestNetworkOnline(true);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('holds the resume refetch while offline and delivers it once on reconnect', async () => {
    jest.useFakeTimers();
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { value: String(++calls) } as TData }) }),
      defaults: { resumeStaleTime: 1000 }
    });
    const fetch = defineFetch<FetchResponse, void, string>({ document, key: 'resume-offline-fetch', select: data => data.value, staleTime: Infinity });
    const Reader = () => {
      fetch.use(undefined);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    expect(calls).toBe(1);

    act(() => {
      jest.advanceTimersByTime(1001);
      setTestNetworkOnline(false);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    // Offline: the owed refetch must not reach the transport.
    expect(calls).toBe(1);

    act(() => {
      setTestNetworkOnline(true);
    });
    await settle();
    // Reconnect delivers exactly the one refetch the offline resume detected.
    expect(calls).toBe(2);

    act(() => {
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    // A fresh result resumes without another network call.
    expect(calls).toBe(2);
    act(() => root.unmount());
  });

  it('replays exactly one follow-up when resume staleness lands during an in-flight fetch', async () => {
    const pending: Array<(value: { data: FetchResponse }) => void> = [];
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: <TData,>() =>
          new Promise<{ data: TData }>(resolve => {
            pending.push(resolve as (value: { data: FetchResponse }) => void);
          })
      }),
      defaults: { resumeStaleTime: 1000 }
    });
    const fetch = defineFetch<FetchResponse, void, string>({ document, key: 'resume-inflight-fetch', select: data => data.value, staleTime: Infinity });
    let latest: string | undefined;
    const Reader = () => {
      latest = fetch.use(undefined).data;
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    expect(pending).toHaveLength(1);

    // Resume staleness lands while the first fetch is still in flight: the response predates it.
    act(() => {
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();

    await act(async () => {
      pending[0]!({ data: { value: 'stale-response' } });
      await settle();
    });
    await act(async () => {
      pending[1]?.({ data: { value: 'fresh-response' } });
      await settle();
    });

    // The landing owes exactly one follow-up request and its response wins.
    expect(pending).toHaveLength(2);
    expect(latest).toBe('fresh-response');
    await settle();
    expect(pending).toHaveLength(2);
    act(() => root.unmount());
  });
});
