import type { GcHost, GcReport } from '../types';
/** Registered once per defineModel; survives resetRuntime like apply targets. */
export declare const registerGcHost: (modelId: string, host: GcHost) => (() => void);
export declare const collectGarbage: () => GcReport;
//# sourceMappingURL=gc.d.ts.map