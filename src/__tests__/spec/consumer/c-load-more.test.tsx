import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { useLoadMore, useRelationLoadMore } from '../../legacyTestApi';
import type { LoadMoreTarget, LoadMoreOptions, QueryResult, ScopeWindowResult } from '../../legacyTestApi';

const renderLoadMore = (initial: { target: LoadMoreTarget; options?: LoadMoreOptions }) => {
  let latest: () => void = () => {};
  const props: { target: LoadMoreTarget; options?: LoadMoreOptions } = initial;
  const Probe = ({ target, options }: { target: LoadMoreTarget; options?: LoadMoreOptions }) => {
    latest = useLoadMore(target, options);
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(Probe, props));
  });
  return {
    loadMore: () => latest(),
    update: (next: { target: LoadMoreTarget; options?: LoadMoreOptions }) => act(() => root.update(React.createElement(Probe, next))),
    unmount: () => act(() => root.unmount())
  };
};

type Row = { id: string };
type RelationProps = {
  window: ScopeWindowResult<Row>;
  query: Pick<QueryResult<unknown>, 'hasNextPage' | 'isFetchingNextPage' | 'fetchNextPage'>;
  options?: LoadMoreOptions;
};

const renderRelationLoadMore = (initial: RelationProps) => {
  let latest: () => void = () => {};
  const Probe = ({ window, query, options }: RelationProps) => {
    latest = useRelationLoadMore(window, query, options);
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(Probe, initial));
  });
  return {
    loadMore: () => latest(),
    update: (next: RelationProps) => act(() => root.update(React.createElement(Probe, next))),
    unmount: () => act(() => root.unmount())
  };
};

const makeWindow = (overrides: Partial<ScopeWindowResult<Row>> = {}): ScopeWindowResult<Row> => ({
  rows: [],
  totalCount: 0,
  hasMore: false,
  fetchNextPage: jest.fn(),
  isPreviousData: false,
  resolved: true,
  ...overrides
});

describe('useLoadMore', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('collapses a burst of calls into one trailing advance', () => {
    const fetchNextPage = jest.fn();
    const probe = renderLoadMore({ target: { hasNextPage: true, isFetchingNextPage: false, fetchNextPage } });
    act(() => {
      probe.loadMore();
      probe.loadMore();
      probe.loadMore();
      jest.advanceTimersByTime(200);
    });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('guards at fire time by hasNextPage and isFetchingNextPage read from the LATEST render', () => {
    const fetchNextPage = jest.fn();
    const probe = renderLoadMore({ target: { hasNextPage: true, isFetchingNextPage: false, fetchNextPage } });
    act(() => probe.loadMore());
    probe.update({ target: { hasNextPage: false, isFetchingNextPage: false, fetchNextPage } });
    act(() => jest.advanceTimersByTime(200));
    expect(fetchNextPage).not.toHaveBeenCalled();

    act(() => probe.loadMore());
    probe.update({ target: { hasNextPage: true, isFetchingNextPage: true, fetchNextPage } });
    act(() => jest.advanceTimersByTime(200));
    expect(fetchNextPage).not.toHaveBeenCalled();
    probe.unmount();
  });

  it('suppresses the advance while enabled is false and fires once re-enabled', () => {
    const fetchNextPage = jest.fn();
    const target: LoadMoreTarget = { hasNextPage: true, isFetchingNextPage: false, fetchNextPage };
    const probe = renderLoadMore({ target, options: { enabled: false } });
    act(() => {
      probe.loadMore();
      jest.advanceTimersByTime(200);
    });
    expect(fetchNextPage).not.toHaveBeenCalled();

    probe.update({ target, options: { enabled: true } });
    act(() => {
      probe.loadMore();
      jest.advanceTimersByTime(200);
    });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('cancels a pending advance on unmount', () => {
    const fetchNextPage = jest.fn();
    const probe = renderLoadMore({ target: { hasNextPage: true, isFetchingNextPage: false, fetchNextPage } });
    act(() => probe.loadMore());
    probe.unmount();
    act(() => jest.advanceTimersByTime(500));
    expect(fetchNextPage).not.toHaveBeenCalled();
  });
});

describe('useRelationLoadMore', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reveals a local page without starting a network request', () => {
    const revealNextPage = jest.fn();
    const fetchNextPage = jest.fn();
    const probe = renderRelationLoadMore({
      window: makeWindow({ hasMore: true, fetchNextPage: revealNextPage }),
      query: { hasNextPage: true, isFetchingNextPage: false, fetchNextPage },
      options: { debounceMs: 1 }
    });

    act(() => {
      probe.loadMore();
      jest.advanceTimersByTime(1);
    });
    expect(revealNextPage).toHaveBeenCalledTimes(1);
    expect(fetchNextPage).not.toHaveBeenCalled();
    probe.unmount();
  });

  it('fetches the server page and reveals it after the local total grows', () => {
    const revealNextPage = jest.fn();
    const fetchNextPage = jest.fn();
    const query = { hasNextPage: true, isFetchingNextPage: false, fetchNextPage };
    const probe = renderRelationLoadMore({
      window: makeWindow({ totalCount: 2, fetchNextPage: revealNextPage }),
      query,
      options: { debounceMs: 1 }
    });

    act(() => {
      probe.loadMore();
      jest.advanceTimersByTime(1);
    });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    expect(revealNextPage).not.toHaveBeenCalled();

    probe.update({
      window: makeWindow({ totalCount: 3, hasMore: true, fetchNextPage: revealNextPage }),
      query,
      options: { debounceMs: 1 }
    });
    expect(revealNextPage).toHaveBeenCalledTimes(1);
    probe.unmount();
  });

  it('does not reveal after an unchanged total or when no local page remains', () => {
    const revealNextPage = jest.fn();
    const fetchNextPage = jest.fn();
    const query = { hasNextPage: true, isFetchingNextPage: false, fetchNextPage };
    const probe = renderRelationLoadMore({
      window: makeWindow({ totalCount: 2, fetchNextPage: revealNextPage }),
      query,
      options: { debounceMs: 1 }
    });

    act(() => {
      probe.loadMore();
      jest.advanceTimersByTime(1);
    });
    probe.update({
      window: makeWindow({ totalCount: 2, hasMore: true, fetchNextPage: revealNextPage }),
      query,
      options: { debounceMs: 1 }
    });
    probe.update({
      window: makeWindow({ totalCount: 3, hasMore: false, fetchNextPage: revealNextPage }),
      query,
      options: { debounceMs: 1 }
    });
    expect(revealNextPage).not.toHaveBeenCalled();
    probe.unmount();
  });
});
