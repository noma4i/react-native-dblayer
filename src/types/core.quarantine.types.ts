import type { OperationRecord } from './core.planes.operationState.types';

/** What a quarantined payload was before it failed validation. */
export type QuarantineEntryKind = 'ledger' | 'operation' | 'row';

/**
 * One quarantined payload: kept verbatim with its reason instead of being dropped. A boot fsck
 * re-decodes entries with the current codecs, so a library update that fixes a codec returns the
 * data automatically.
 */
export type QuarantineEntry = {
  kind: QuarantineEntryKind;
  model: string;
  id: string;
  raw: unknown;
  reason: string;
};

export type QuarantineState = {
  entries: QuarantineEntry[];
};

/** Salvage verdict for the persisted ops record: unreadable envelope, or per-record split. */
export type LedgerSalvage =
  | { kind: 'unreadable' }
  | {
      kind: 'salvaged';
      operations: Record<string, OperationRecord>;
      committedKeys: string[];
      quarantined: Array<{ id: string; raw: unknown; reason: string }>;
      rewrite: boolean;
    };
