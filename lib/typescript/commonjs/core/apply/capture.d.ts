export type Capture = {
    entityClock: number;
    scopeGeneration: number;
};
/** Capture causality before transport starts. */
export declare const captureApplyState: (entityClock: number, scopeGeneration: number) => Capture;
//# sourceMappingURL=capture.d.ts.map