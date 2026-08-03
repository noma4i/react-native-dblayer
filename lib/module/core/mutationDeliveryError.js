"use strict";

/** Marks a mutation whose request left the client without an observable response. */
export class MutationDeliveryUnknownError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MutationDeliveryUnknownError';
  }
}
//# sourceMappingURL=mutationDeliveryError.js.map