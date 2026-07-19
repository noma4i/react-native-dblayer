import { useRef } from 'react';
import type { Dependency } from '../core/apply/commitBus';
import { arraysShallowEqual, rowsShallowEqual, useLiveRead } from './useLiveRead';

type Row = { id: string; [key: string]: unknown };

export type ProjectionOptions<TStored extends Row, TProjection extends Record<string, unknown> = TStored> =
  | { select: (row: TStored) => TProjection; renderKeys?: never }
  | { select?: never; renderKeys: readonly (keyof TStored & string)[] }
  | { select?: never; renderKeys?: never };

type GateEntry<TStored extends Row, TOutput extends Record<string, unknown>> = {
  source: unknown;
  output: TOutput;
  equalityValue: Record<string, unknown>;
};

const equalityValue = <TStored extends Row, TOutput extends Record<string, unknown>>(
  source: TStored,
  output: TOutput,
  options: ProjectionOptions<TStored, TOutput>
): Record<string, unknown> => {
  if (options.select) return output;
  if (options.renderKeys) return Object.fromEntries(options.renderKeys.map(key => [key, source[key]]));
  return output;
};

/** Throw when a row-level read declares both mutually exclusive projection modes. Views may explicitly allow render keys over selected output. */
export const validateProjectionOptions = (
  options: { select?: unknown; renderKeys?: readonly string[] } | undefined,
  surface: string,
  validation?: { allowCombined?: boolean }
): void => {
  if (!validation?.allowCombined && options?.select && options.renderKeys) throw new Error(`${surface} cannot use select and renderKeys together`);
};

/** Create one hook-local row projection gate with stable item and array references. */
export const createProjectionGate = <TStored extends Row, TOutput extends Record<string, unknown>>() => {
  const entries = new Map<string, GateEntry<TStored, TOutput>>();
  let previousRows: TOutput[] = [];
  return {
    projectValue(id: string, source: unknown, output: TOutput, renderKeys?: readonly string[]): TOutput {
      const current = entries.get(id);
      if (current && current.source === source) return current.output;
      const nextEqualityValue = renderKeys ? Object.fromEntries(renderKeys.map(key => [key, output[key]])) : output;
      if (current && rowsShallowEqual(current.equalityValue, nextEqualityValue)) {
        entries.set(id, { source, output: current.output, equalityValue: nextEqualityValue });
        return current.output;
      }
      entries.set(id, { source, output, equalityValue: nextEqualityValue });
      return output;
    },
    project(row: TStored, options: ProjectionOptions<TStored, TOutput>): TOutput {
      const output = (options.select ? options.select(row) : row) as TOutput;
      const nextEqualityValue = equalityValue(row, output, options);
      return this.projectValue(row.id, row, output, Object.keys(nextEqualityValue));
    },
    projectRows(rows: TStored[], options: ProjectionOptions<TStored, TOutput>): TOutput[] {
      const liveIds = new Set(rows.map(row => row.id));
      const next = rows.map(row => this.project(row, options));
      for (const id of entries.keys()) if (!liveIds.has(id)) entries.delete(id);
      if (arraysShallowEqual(previousRows, next)) return previousRows;
      previousRows = next;
      return next;
    }
  };
};

/** Read and gate one optional stored row while keeping selector identity outside dependencies. */
export const useProjectedLiveRow = <TStored extends Row, TOutput extends Record<string, unknown>>(
  compute: () => TStored | undefined,
  deps: ReadonlyArray<Dependency>,
  options: ProjectionOptions<TStored, TOutput>,
  surface: string
): TOutput | undefined => {
  validateProjectionOptions(options, surface);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate<TStored, TOutput>());
  optionsRef.current = options;
  return useLiveRead(
    () => {
      const row = compute();
      return row ? gateRef.current.project(row, optionsRef.current) : undefined;
    },
    deps,
    Object.is
  );
};

/** Read and gate stored rows while keeping selector identity outside dependencies. */
export const useProjectedLiveRows = <TStored extends Row, TOutput extends Record<string, unknown>>(
  compute: () => TStored[],
  deps: ReadonlyArray<Dependency>,
  options: ProjectionOptions<TStored, TOutput>,
  surface: string
): TOutput[] => {
  validateProjectionOptions(options, surface);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate<TStored, TOutput>());
  optionsRef.current = options;
  return useLiveRead(() => gateRef.current.projectRows(compute(), optionsRef.current), deps, arraysShallowEqual);
};
