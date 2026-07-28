import * as React from 'react';
import * as TestRenderer from 'react-test-renderer';
import { act } from 'react';
import { useMergedScopeRows } from '../../../index';

type TestRow = { id: string; name: string; score: number };

type MergedReader = {
  result: () => ReadonlyArray<TestRow>;
  update: (baseRows: ReadonlyArray<TestRow>, extraRows: ReadonlyArray<TestRow>, comparator?: (left: TestRow, right: TestRow) => number) => void;
  unmount: () => void;
};

const renderMerged = (
  baseRows: ReadonlyArray<TestRow>,
  extraRows: ReadonlyArray<TestRow>,
  comparator?: (left: TestRow, right: TestRow) => number
): MergedReader => {
  let current!: ReadonlyArray<TestRow>;
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = (props: { baseRows: ReadonlyArray<TestRow>; extraRows: ReadonlyArray<TestRow>; comparator?: (left: TestRow, right: TestRow) => number }) => {
    current = useMergedScopeRows(props.baseRows, props.extraRows, props.comparator ? { comparator: props.comparator } : undefined);
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(Reader, { baseRows, extraRows, comparator }));
  });

  return {
    result: () => current,
    update: (nextBase, nextExtras, nextComparator) =>
      act(() => root.update(React.createElement(Reader, { baseRows: nextBase, extraRows: nextExtras, comparator: nextComparator }))),
    unmount: () => act(() => root.unmount())
  };
};

describe('useMergedScopeRows', () => {
  it('drops extras whose id already exists in base, appending surviving extras after base in original order', () => {
    const baseRows: TestRow[] = [
      { id: '1', name: 'one', score: 1 },
      { id: '2', name: 'two', score: 2 }
    ];
    const extraRows: TestRow[] = [
      { id: '2', name: 'two-dup', score: 20 },
      { id: '3', name: 'three', score: 3 },
      { id: '4', name: 'four', score: 4 }
    ];

    const reader = renderMerged(baseRows, extraRows);

    expect(reader.result()).toEqual([
      { id: '1', name: 'one', score: 1 },
      { id: '2', name: 'two', score: 2 },
      { id: '3', name: 'three', score: 3 },
      { id: '4', name: 'four', score: 4 }
    ]);
    reader.unmount();
  });

  it('returns the base array by reference when every extra is a dedup and no comparator is given', () => {
    const baseRows: TestRow[] = [
      { id: '1', name: 'one', score: 1 },
      { id: '2', name: 'two', score: 2 }
    ];
    const extraRows: TestRow[] = [{ id: '1', name: 'one-dup', score: 10 }];

    const reader = renderMerged(baseRows, extraRows);

    expect(reader.result()).toBe(baseRows);
    reader.unmount();
  });

  it('returns the same result reference on idle re-render with identical inputs and does not re-invoke the comparator', () => {
    const baseRows: TestRow[] = [
      { id: '2', name: 'two', score: 2 },
      { id: '1', name: 'one', score: 1 }
    ];
    const extraRows: TestRow[] = [{ id: '3', name: 'three', score: 3 }];
    const comparator = jest.fn((left: TestRow, right: TestRow) => left.score - right.score);

    const reader = renderMerged(baseRows, extraRows, comparator);
    const firstResult = reader.result();
    const callCountAfterMount = comparator.mock.calls.length;
    expect(callCountAfterMount).toBeGreaterThan(0);

    reader.update(baseRows, extraRows, comparator);

    expect(reader.result()).toBe(firstResult);
    expect(comparator.mock.calls.length).toBe(callCountAfterMount);
    reader.unmount();
  });

  it('sorts merged rows with the comparator, and resorts base-only rows into a new array without mutating base', () => {
    const baseRows: TestRow[] = [
      { id: '2', name: 'two', score: 2 },
      { id: '1', name: 'one', score: 1 }
    ];
    const extraRows: TestRow[] = [{ id: '3', name: 'three', score: 3 }];
    const comparator = (left: TestRow, right: TestRow) => left.score - right.score;

    const mergedReader = renderMerged(baseRows, extraRows, comparator);
    expect(mergedReader.result()).toEqual([
      { id: '1', name: 'one', score: 1 },
      { id: '2', name: 'two', score: 2 },
      { id: '3', name: 'three', score: 3 }
    ]);
    mergedReader.unmount();

    const baseOnlyOriginal = [...baseRows];
    const baseOnlyReader = renderMerged(baseRows, [{ id: '2', name: 'two-dup', score: 20 }], comparator);

    expect(baseOnlyReader.result()).toEqual([
      { id: '1', name: 'one', score: 1 },
      { id: '2', name: 'two', score: 2 }
    ]);
    expect(baseOnlyReader.result()).not.toBe(baseRows);
    expect(baseRows).toEqual(baseOnlyOriginal);
    baseOnlyReader.unmount();
  });

  it('keeps the previous result reference when base is replaced by a new array with the same elements in the same order', () => {
    const baseRows: TestRow[] = [
      { id: '1', name: 'one', score: 1 },
      { id: '2', name: 'two', score: 2 }
    ];
    const extraRows: TestRow[] = [{ id: '3', name: 'three', score: 3 }];

    const reader = renderMerged(baseRows, extraRows);
    const firstResult = reader.result();

    const nextBaseRows = [...baseRows];
    reader.update(nextBaseRows, extraRows);

    expect(reader.result()).toBe(firstResult);
    reader.unmount();
  });
});
