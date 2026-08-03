/** Marks a mutation whose request left the client without an observable response. */
export class MutationDeliveryUnknownError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MutationDeliveryUnknownError';
  }
}
