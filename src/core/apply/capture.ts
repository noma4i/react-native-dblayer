export type Capture = { entityClock: number; scopeGeneration: number };

/** Capture causality before transport starts. */
export const captureApplyState = (entityClock: number, scopeGeneration: number): Capture => ({ entityClock, scopeGeneration });
