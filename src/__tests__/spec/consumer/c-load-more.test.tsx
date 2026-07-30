import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { useLoadMore } from '../../../index';
import type { LoadMoreTarget, LoadMoreOptions } from '../../../index';

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
