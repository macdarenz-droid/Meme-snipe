/** Rows for the discovered-token table, filled by the worker API later. */
export interface TokenRowView {
  mint: string;
  symbol: string;
  ageSeconds: number;
  venue: string;
  liquidityUsd: number;
  volume24hUsd: number;
  holders: number;
  topHolderShare: number;
  security: 'passed' | 'failed' | 'missing';
  promoted: boolean;
  dataAgeSeconds: number;
}
