/**
 * Deposit and withdraw routes. Source: docs/research/funding.md (fees checked
 * 2026-10-03 at SOL/AUD about A$171.58). Update both together.
 */
export type ExchangeId = 'ir' | 'kraken';

export interface Cost {
  label: string;
  value: string;
}

export interface Route {
  steps: string[];
  costs: Cost[];
  /** Example totals for the bankroll sizes the owner uses. */
  totals: Cost[];
}

export interface Exchange {
  id: ExchangeId;
  name: string;
  url: string;
  deposit: Route;
  withdraw: Route;
}

export const FEES_CHECKED = '3 Oct 2026';

export const EXCHANGES: Exchange[] = [
  {
    id: 'ir',
    name: 'Independent Reserve',
    url: 'https://www.independentreserve.com/',
    deposit: {
      steps: [
        'Add your own wallet to the address book and declare it as yours.',
        'Deposit AUD by PayID.',
        'Buy SOL on the SOL/AUD market with a limit order at the ask.',
        'Withdraw the SOL to your own wallet.',
        'Send the bot allowance from your wallet to the bot wallet.',
      ],
      costs: [
        { label: 'PayID deposit', value: 'Free' },
        { label: 'Trading fee', value: '0.5%' },
        { label: 'Minimum order', value: '0.004 SOL' },
        { label: 'SOL withdrawal', value: '0.001 SOL (≈ A$0.17)' },
        { label: 'Wallet to bot wallet', value: '0.000005 SOL' },
      ],
      totals: [
        { label: 'A$20 in', value: '≈ A$0.29 (1.4%)' },
        { label: 'A$50 in', value: '≈ A$0.46 (0.9%)' },
      ],
    },
    withdraw: {
      steps: [
        'Zeroed sends SOL from the bot wallet to your saved wallet.',
        'Send the SOL from your wallet to your Independent Reserve SOL address.',
        'Sell SOL for AUD.',
        'Withdraw by EFT if the amount is A$50 or more, otherwise by PayID.',
      ],
      costs: [
        { label: 'Trading fee', value: '0.5%' },
        { label: 'EFT withdrawal', value: 'Free, A$50 minimum' },
        { label: 'PayID withdrawal', value: 'A$1.50' },
      ],
      totals: [
        { label: 'A$20 out by PayID', value: '≈ A$1.62 (8.1%)' },
        { label: 'A$50 out by EFT', value: '≈ A$0.29' },
      ],
    },
  },
  {
    id: 'kraken',
    name: 'Kraken',
    url: 'https://www.kraken.com/',
    deposit: {
      steps: [
        'Add your own wallet as a withdrawal address and confirm it.',
        'Deposit AUD by PayID (A$5 minimum).',
        'Buy SOL on Kraken Pro with a limit order.',
        'Withdraw the SOL to your own wallet (0.011 SOL minimum).',
        'Send the bot allowance from your wallet to the bot wallet.',
      ],
      costs: [
        { label: 'PayID deposit', value: 'Free, A$5 minimum' },
        { label: 'Trading fee (Pro)', value: '0.40% maker, 0.80% taker' },
        { label: 'SOL withdrawal', value: '0.005 SOL (≈ A$0.86)' },
        { label: 'Wallet to bot wallet', value: '0.000005 SOL' },
      ],
      totals: [
        { label: 'A$20 in', value: '≈ A$0.94 maker, A$1.02 taker' },
        { label: 'A$50 in', value: '≈ A$1.06 maker, A$1.26 taker' },
      ],
    },
    withdraw: {
      steps: [
        'Zeroed sends SOL from the bot wallet to your saved wallet.',
        'Send the SOL from your wallet to your Kraken SOL address.',
        'Sell SOL for AUD on Kraken Pro.',
        'Withdraw AUD to your bank (A$5 minimum).',
      ],
      costs: [
        { label: 'Trading fee (Pro)', value: '0.40% maker, 0.80% taker' },
        { label: 'AUD withdrawal', value: 'Free, A$5 minimum' },
      ],
      totals: [
        { label: 'A$20 out (taker)', value: '≈ A$0.16 (0.8%)' },
        { label: 'A$50 out (taker)', value: '≈ A$0.40' },
      ],
    },
  },
];
