import type { SessionView, TokenRowView, WalletView } from '../screens/types.ts';

/** Build check marker: scripts/check-build.mjs fails if this string reaches dist/. */
export const FIXTURE_MARKER = 'ZEROED_FIXTURES_DEV_ONLY';

// Large on purpose: layouts must hold a scaled-up bankroll and trade size.
const BANKROLL = 25000;
const ENTRY = 500;
const MAX_ENTRY = 1250;
const FAKE_MINT = (n: number) => `FAKEmint${String(n).padStart(4, '0')}xxxxxxxxxxxxxxxxxxxxxxxxxxxx`;

export const fixtureTokens: TokenRowView[] = Array.from({ length: 8 }, (_, i) => ({
  mint: FAKE_MINT(100 + i),
  symbol: `FAKE${i + 1}`,
  ageSeconds: 90 + i * 410,
  venue: i % 2 ? 'PumpSwap' : 'Pump curve',
  liquidityUsd: 4000 + i * 2300,
  volume24hUsd: 12000 + i * 5100,
  holders: 120 + i * 37,
  topHolderShare: 0.08 + i * 0.02,
  security: i === 3 ? 'failed' : i === 5 ? 'missing' : 'passed',
  promoted: i === 2,
  dataAgeSeconds: 2 + i * 3,
}));

export const fixtureSession: SessionView = {
  mode: 'paper',
  state: 'running',
  bankrollUsd: BANKROLL,
  entryUsd: ENTRY,
  maxEntryUsd: MAX_ENTRY,
  maxOpenPositions: 3,
  dailyLossLimitUsd: 500,
  sessionLossLimitUsd: 1000,
  workerConnected: true,
};

/**
 * Addresses are 44 characters, the longest a Solana address can be, and never a real one: "0", "O" and "I" are not
 * base58, so no wallet accepts them and nothing sent can reach an address nobody controls (SAMPLE-QR).
 */
export const fixtureWallet: WalletView = {
  botAddress: 'SAMPLE0BOT0WALLET000000000000000000000000000',
  savedWallet: 'SAMPLE0SAVED0WALLET0000000000000000000000000',
  availableUsd: 23812.4,
  balanceSol: '138.456',
  solAud: '171.58',
  reserveSol: '0.75',
  lockedSol: '0.0123',
  openExposureUsd: ENTRY,
  feesPaidUsd: 612.37,
};
