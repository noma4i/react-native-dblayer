/**
 * Register a deferred definition check that runs during `bootDb` after every model has registered.
 * @param key Stable definition identity; re-registration replaces the previous validation.
 * @param validation Check to run on every boot; throw to fail the boot.
 */
export declare const registerBootValidation: (key: string, validation: () => void) => void;
/** Run all deferred definition checks before the boot fsck starts. */
export declare const runBootValidations: () => void;
//# sourceMappingURL=bootValidations.d.ts.map