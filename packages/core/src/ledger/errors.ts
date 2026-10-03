/** Machine-readable reasons a caller may need to tell apart. Most ledger errors carry none. */
export type LedgerErrorCode = 'reducer_refused';

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
  readonly code: LedgerErrorCode | null;

  constructor(message: string, options: { readonly code?: LedgerErrorCode } = {}) {
    super(message);
    this.code = options.code ?? null;
  }
}
