import { bridgeWindowPagination, type ScopeWindowResult } from '../../../index';

// Pure combiner contracts: window-first pagination bridge.

const makeWindow = (overrides: Partial<ScopeWindowResult<{ id: string }>> = {}): ScopeWindowResult<{ id: string }> => ({
  rows: [{ id: 'r-1' }],
  totalCount: 1,
  hasMore: false,
  fetchNextPage: jest.fn(),
  isPreviousData: false,
  resolved: true,
  ...overrides
});

const makeQuery = (overrides: Partial<Parameters<typeof bridgeWindowPagination>[1]> = {}): Parameters<typeof bridgeWindowPagination>[1] => ({
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: jest.fn(),
  loadingState: { phase: 'ready' } as never,
  error: null,
  ...overrides
});

describe('bridgeWindowPagination', () => {
  it('advances the local window first while it has more', () => {
    const window = makeWindow({ hasMore: true });
    const query = makeQuery({ hasNextPage: true });
    const bridge = bridgeWindowPagination(window, query);
    bridge.fetchNextPage();
    expect(window.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(query.fetchNextPage).not.toHaveBeenCalled();
  });

  it('falls through to the network page when the window is exhausted', () => {
    const window = makeWindow({ hasMore: false });
    const query = makeQuery({ hasNextPage: true });
    const bridge = bridgeWindowPagination(window, query);
    bridge.fetchNextPage();
    expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(window.fetchNextPage).not.toHaveBeenCalled();
  });

  it('ORs hasNextPage across both sources', () => {
    expect(bridgeWindowPagination(makeWindow({ hasMore: true }), makeQuery({ hasNextPage: false })).hasNextPage).toBe(true);
    expect(bridgeWindowPagination(makeWindow({ hasMore: false }), makeQuery({ hasNextPage: true })).hasNextPage).toBe(true);
    expect(bridgeWindowPagination(makeWindow({ hasMore: false }), makeQuery({ hasNextPage: false })).hasNextPage).toBe(false);
  });

  it('passes window rows and query state through unchanged', () => {
    const window = makeWindow();
    const query = makeQuery({ error: new Error('boom'), isFetchingNextPage: true });
    const bridge = bridgeWindowPagination(window, query);
    expect(bridge.rows).toBe(window.rows);
    expect(bridge.totalCount).toBe(1);
    expect(bridge.resolved).toBe(true);
    expect(bridge.isFetchingNextPage).toBe(true);
    expect(bridge.error).toBe(query.error);
    expect(bridge.loadingState).toBe(query.loadingState);
  });
});
