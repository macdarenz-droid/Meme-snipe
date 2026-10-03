/** Data that does not match the layout it claims to be. Decoders throw it; they never guess a value. */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}
