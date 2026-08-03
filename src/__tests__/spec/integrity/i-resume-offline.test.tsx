import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import React, { act } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, setTestNetworkOnline, settle } from '../helpers/harness';

type ResponseData = { value: string };
type ResultRow = { id: string; value: string };
type Variables = Record<string, never>;

const document: TypedDocumentNode<ResponseData, Variables> = { kind: Kind.DOCUMENT, definitions: [] };
const ResultSchema = defineShape<ResultRow>()({ value: f.str() });

/**
 * Foreground resume combined with a dead network: the resume drain must not fire transport calls
 * while offline, must not lose the staleness it detected, and reconnecting must deliver exactly
 * the refetch the offline resume owed - the two states compose instead of cancelling each other.
 */
describe('foreground resume while offline', () => {
  let appStateHandler: ((state: AppStateStatus) => void) | undefined;

  beforeEach(() => {
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      appStateHandler = handler;
      return { remove: jest.fn() };
    });
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
    const ResultModel = defineModel('SpecResumeOfflineReconnect', {
      schema: ResultSchema,
      relations: owner => ({
        result: {
          remote: owner.gql.single(document, {
            variables: () => ({}),
            select: data => ({ id: 'resume-offline-result', value: data.value }),
            staleTime: Infinity
          })
        }
      })
    });
    const relation = ResultModel.result({});
    const Reader = () => {
      relation.use();
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
    const pending: Array<(value: { data: ResponseData }) => void> = [];
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: <TData,>() =>
          new Promise<{ data: TData }>(resolve => {
            pending.push(resolve as (value: { data: ResponseData }) => void);
          })
      }),
      defaults: { resumeStaleTime: 1000 }
    });
    const ResultModel = defineModel('SpecResumeOfflineInflight', {
      schema: ResultSchema,
      relations: owner => ({
        result: {
          remote: owner.gql.single(document, {
            variables: () => ({}),
            select: data => ({ id: 'resume-inflight-result', value: data.value }),
            staleTime: Infinity
          })
        }
      })
    });
    const relation = ResultModel.result({});
    let latest: string | undefined;
    const Reader = () => {
      latest = relation.use().data?.value;
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
