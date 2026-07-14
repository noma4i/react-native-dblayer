export type CommitChange = {
    model: string;
    ids: string[];
    scopeKeys: string[];
    fields: string[];
};
export type CommitListener = (changes: CommitChange[]) => void;
/** Emits exactly one semantic notification after an applied plan commits. */
export declare const createCommitBus: () => {
    subscribe: (listener: CommitListener) => () => boolean;
    publish: (changes: CommitChange[]) => void;
};
//# sourceMappingURL=commitBus.d.ts.map