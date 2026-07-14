import type { JournalOp } from './journal';
import type { Capture } from './capture';

export type ApplyPlan = { capture: Capture; ops: JournalOp[]; hash: string };

/** Build a side-effect-free plan before opening an in-memory transaction. */
export const createApplyPlan = (capture: Capture, ops: JournalOp[]): ApplyPlan => ({
  capture,
  ops,
  hash: JSON.stringify(ops)
});
