import type { ModelWaitOptions } from '../types';
/** Resolve a committed model row or finish with `undefined` at a terminal boundary. */
export declare const waitForCommittedRow: <TStored extends {
    id: string;
}>(model: {
    key: string;
    find(id: string | null | undefined): TStored | undefined;
}, id: string | null | undefined, options: ModelWaitOptions) => Promise<TStored | undefined>;
//# sourceMappingURL=waitForCommittedRow.d.ts.map