import type { AppliedOp, StoragePlane } from '../../types';
import { noteDataLoss } from '../diagnostics';
import { getDbLogger } from '../logger';

const DELTA_RECORD_VERSION = 1;
const SEQ_WIDTH = 12;
const OP_KINDS = new Set(['upsert', 'destroy', 'scope', 'scope-delta']);

export const deltaKey = (prefix: string, seq: number): string => `${prefix}delta:${String(seq).padStart(SEQ_WIDTH, '0')}`;
export const snapseqKey = (prefix: string, model: string): string => `${prefix}snapseq:${model}`;

/** Light delta codec: the ops already passed the lossless gate at plan time - one stringify pass, no checksum. */
export const encodeDelta = (seq: number, ops: AppliedOp[]): string => JSON.stringify({ recordVersion: DELTA_RECORD_VERSION, seq, ops });

export type DecodedDelta = { seq: number; ops: AppliedOp[] };

const isDeltaOp = (value: unknown): value is AppliedOp =>
  typeof value === 'object' && value !== null && OP_KINDS.has((value as { kind?: unknown }).kind as string) && typeof (value as { model?: unknown }).model === 'string';

export const decodeDelta = (raw: string): DecodedDelta | null => {
  try {
    const parsed = JSON.parse(raw) as { recordVersion?: unknown; seq?: unknown; ops?: unknown };
    if (parsed.recordVersion !== DELTA_RECORD_VERSION) return null;
    if (typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq) || parsed.seq < 0) return null;
    if (!Array.isArray(parsed.ops) || !parsed.ops.every(isDeltaOp)) return null;
    return { seq: parsed.seq, ops: parsed.ops as AppliedOp[] };
  } catch {
    return null;
  }
};

export const readSnapseq = (storage: StoragePlane, prefix: string, model: string): number => {
  const raw = storage.get(snapseqKey(prefix, model));
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
};

/**
 * Read the persisted delta tail in seq order. A broken delta cuts the tail: it and every later
 * delta are removed with a loss counter, and every persisted query record is evicted so each
 * reader refetches on its next mount instead of trusting a snapshot with a hole in it.
 */
export const readDeltaLog = (storage: StoragePlane, prefix: string): DecodedDelta[] => {
  const keys = storage.keys(`${prefix}delta:`).sort();
  const deltas: DecodedDelta[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const raw = storage.get(keys[index]!);
    const decoded = raw === undefined ? null : decodeDelta(raw);
    if (decoded !== null) {
      deltas.push(decoded);
      continue;
    }
    const cut = keys.slice(index);
    for (const key of cut) storage.set(key, null);
    for (const key of storage.keys(`${prefix}query`)) storage.set(key, null);
    noteDataLoss('delta-tail-cut', '__runtime__', cut.length);
    getDbLogger().error('delta tail cut', { from: keys[index], dropped: cut.length });
    break;
  }
  return deltas;
};

/** Highest seq the disk knows: the next session's counter continues after it. */
export const highestPersistedSeq = (storage: StoragePlane, prefix: string): number => {
  let highest = -1;
  for (const key of storage.keys(`${prefix}delta:`)) {
    const seq = Number(key.slice(key.lastIndexOf(':') + 1));
    if (Number.isSafeInteger(seq) && seq > highest) highest = seq;
  }
  for (const key of storage.keys(`${prefix}snapseq:`)) {
    const raw = storage.get(key);
    const seq = raw === undefined ? Number.NaN : Number(raw);
    if (Number.isSafeInteger(seq) && seq > highest) highest = seq;
  }
  return highest;
};
