"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.MutationDeliveryUnknownError = void 0;
/** Marks a mutation whose request left the client without an observable response. */
class MutationDeliveryUnknownError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MutationDeliveryUnknownError';
  }
}
exports.MutationDeliveryUnknownError = MutationDeliveryUnknownError;
//# sourceMappingURL=mutationDeliveryError.js.map