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
});
