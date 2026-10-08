// The hard ceilings file (B-M25-01 logic 3; ARCH M25): absolute maxima the API and the engine can never write. The
// signer reads its own copy. JSON with exactly these keys; lamports as decimal strings (u64), counts and bps as
// integers. Every value must be positive.
import type { Bps, Lamports, Result } from '@bot/types';

export interface Ceilings {
  perTradeNotionalLamports: Lamports; openPositions: number; dailyLossLamports: Lamports; hotWalletCapLamports: Lamports; slippageBps: Bps;
  signerDayCapLamports: Lamports; tipCapLamports: Lamports; exitFeeCapLamports: Lamports;
}

const FIELDS = {
  per_trade_notional_lamports: ['perTradeNotionalLamports', 'lamports'], open_positions: ['openPositions', 'count'],
  daily_loss_lamports: ['dailyLossLamports', 'lamports'], hot_wallet_cap_lamports: ['hotWalletCapLamports', 'lamports'],
  slippage_bps: ['slippageBps', 'bps'], signer_day_cap_lamports: ['signerDayCapLamports', 'lamports'], tip_cap_lamports: ['tipCapLamports', 'lamports'],
  exit_fee_cap_lamports: ['exitFeeCapLamports', 'lamports'],
} as const;
export const CEILING_KEYS = Object.keys(FIELDS);
const U64_RE = /^[1-9][0-9]{0,19}$/;
const U64_MAX = 18_446_744_073_709_551_615n;

export function parseCeilings(text: string): Result<Ceilings, { code: 'E_CEILINGS_INVALID'; message: string }> {
  const bad = (message: string) => ({ ok: false as const, error: { code: 'E_CEILINGS_INVALID' as const, message } });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return bad('not valid JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return bad('not a JSON object');
  const obj = json as Record<string, unknown>;
  const extra = Object.keys(obj).filter((k) => !(k in FIELDS));
  if (extra.length > 0) return bad(`unknown keys: ${extra.sort().join(', ')}`);
  const out: Record<string, unknown> = {};
  for (const [key, [name, kind]] of Object.entries(FIELDS)) {
    const v = obj[key];
    if (kind === 'lamports') {
      if (typeof v !== 'string' || !U64_RE.test(v) || BigInt(v) > U64_MAX) return bad(`${key} must be a positive u64 decimal string`);
      out[name] = BigInt(v);
    } else {
      const max = kind === 'bps' ? 10_000 : 1_000;
      if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > max) return bad(`${key} must be an integer from 1 to ${max}`);
      out[name] = v;
    }
  }
  return { ok: true, value: Object.freeze(out) as unknown as Ceilings };
}
