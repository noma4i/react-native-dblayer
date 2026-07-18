/** Register a deferred definition check that runs during `bootDb` after every model has registered. */
export declare const registerBootValidation: (validation: () => void) => void;
/** Run all deferred definition checks before journal replay starts. */
export declare const runBootValidations: () => void;
//# sourceMappingURL=bootValidations.d.ts.map
