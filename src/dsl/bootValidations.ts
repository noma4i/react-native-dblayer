import { registerReset } from '../core/reset';

let validations: Array<() => void> = [];

/** Register a deferred definition check that runs during `bootDb` after every model has registered. */
export const registerBootValidation = (validation: () => void): void => {
  validations.push(validation);
};

/** Run all deferred definition checks before journal replay starts. */
export const runBootValidations = (): void => {
  for (const validation of validations) validation();
};

registerReset(() => {
  validations = [];
});
