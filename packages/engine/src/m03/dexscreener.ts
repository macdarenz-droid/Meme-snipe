// DexScreener coverage cross-check (SPEC-A A-M03-04, card Z08): measures our pool coverage against a second source
// [ST-25]; never used for trading and never adds a pool (pools come only from chain reads). Pointed at migrations
// (Z-H-OF round 3): the caller passes the base mints of the pools A-M03-02 recorded in the last 24 h (card Z09 wires
// it, ruling Z08-9) and the pool addresses we know for them; the result goes into the daily manifest (A-M05-03).
//
// VERIFY [VF-15] (docs.dexscreener.com/api/reference, read 2026-10-07): GET /tokens/v1/{chainId}/{tokenAddresses},
// chainId `solana`, up to 30 comma-separated addresses; pair fields include
// chainId, dexId, pairAddress, baseToken, quoteToken. The dexId DexScreener gives PumpSwap pairs is NOT in the register:
// `discovery.dexscreener.pumpswap_dex_ids` (default ["pumpswap"]) is UNVERIFIED; pairs with any other dexId are only
// counted (`otherDexPairs`, logged), so a wrong id shows up as a count, never as a silent miss of every pair; and a pool
// we know listed under any other dexId sets `status` to `dex_id_mismatch` (ruling Z08-30), since that is the sign the
// configured id is wrong. The register's 300 requests a minute for /tokens is UNVERIFIED (the reference page shows only
// 60/min); M14 runs DexScreener at 30 a minute until a source confirms it (Z08-30, SPEC-A C-95).
// Vendor data is untrusted: every field is checked; it is stored privately only and never redistributed (A-32, VF-15).
import type { Pubkey, Result, UnixMs } from '@bot/types';
import type { RpcError } from '../m14/types.ts';
import type { ServiceReq } from '../m14/services.ts';

export const MAX_MINTS_PER_CALL = 30;

export interface CrossCheckResult {
  checkedMints: number;
  poolsOnlyInVendor: Array<{ mint: Pubkey; pairAddress: Pubkey; dexId: string }>;
  /** Pairs for those mints under a dexId not configured as PumpSwap's (shown so a wrong id is visible). */
  otherDexPairs: number;
  asOfMs: UnixMs;
  /** `dex_id_mismatch`: a pool we know came back under a dexId not configured as PumpSwap's (the id is likely wrong). */
  status: 'ok' | 'partial' | 'unavailable' | 'dex_id_mismatch';
}

export interface DexScreenerDeps {
  http: (req: ServiceReq) => Promise<Result<unknown, RpcError>>;
  nowMs: () => UnixMs;
  isPubkey: (s: string) => boolean;
  pumpswapDexIds: readonly string[];
  maxCallsPerDay: number;
  enabled: boolean;
  log?: { event(level: 'info' | 'warn', code: string, fields: Readonly<Record<string, unknown>>): void };
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One pair of the vendor's answer when it has the fields we use and they are well formed; else null. */
function pairOf(x: unknown, isPubkey: (s: string) => boolean): { mint: Pubkey; pairAddress: Pubkey; dexId: string } | null {
  if (typeof x !== 'object' || x === null) return null;
  const p = x as Record<string, unknown>;
  const base = p.baseToken as Record<string, unknown> | undefined;
  if (p.chainId !== 'solana' || typeof p.dexId !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(p.dexId)) return null;
  if (typeof p.pairAddress !== 'string' || !BASE58.test(p.pairAddress) || !isPubkey(p.pairAddress)) return null;
  if (typeof base !== 'object' || base === null || typeof base.address !== 'string' || !BASE58.test(base.address) || !isPubkey(base.address)) return null;
  return { mint: base.address, pairAddress: p.pairAddress, dexId: p.dexId };
}

export function createCrossCheck(deps: DexScreenerDeps): {
  crossCheck(mints: readonly Pubkey[], knownPools: ReadonlySet<Pubkey>): Promise<CrossCheckResult>;
} {
  let day = '';
  let calls = 0;
  return {
    async crossCheck(mints, knownPools): Promise<CrossCheckResult> {
      const asOfMs = deps.nowMs();
      const out: CrossCheckResult = { checkedMints: 0, poolsOnlyInVendor: [], otherDexPairs: 0, asOfMs, status: 'ok' };
      if (!deps.enabled) return { ...out, status: 'unavailable' };
      const unique = [...new Set(mints)].filter((m) => BASE58.test(m) && deps.isPubkey(m));
      const asked = new Set(unique);
      const seen = new Set<string>();
      let knownUnderOther = 0;
      for (let i = 0; i < unique.length; i += MAX_MINTS_PER_CALL) {
        const today = new Date(deps.nowMs()).toISOString().slice(0, 10);
        if (today !== day) { day = today; calls = 0; }
        if (calls >= deps.maxCallsPerDay) { out.status = out.checkedMints === 0 ? 'unavailable' : 'partial'; break; }
        calls += 1;
        const chunk = unique.slice(i, i + MAX_MINTS_PER_CALL);
        const r = await deps.http({ method: 'GET', path: `/tokens/v1/solana/${chunk.join(',')}`, endpoint: 'pairs' });
        if (!r.ok || !Array.isArray(r.value)) { out.status = out.checkedMints === 0 ? 'unavailable' : 'partial'; break; }
        out.checkedMints += chunk.length;
        for (const x of r.value) {
          const p = pairOf(x, deps.isPubkey);
          if (p === null || !asked.has(p.mint) || seen.has(p.pairAddress)) continue;
          seen.add(p.pairAddress);
          if (!deps.pumpswapDexIds.includes(p.dexId)) {
            out.otherDexPairs += 1;
            if (knownPools.has(p.pairAddress)) knownUnderOther += 1;
            continue;
          }
          if (!knownPools.has(p.pairAddress)) out.poolsOnlyInVendor.push(p);
        }
      }
      if (knownUnderOther > 0 && out.status === 'ok') out.status = 'dex_id_mismatch';
      deps.log?.event(out.status === 'ok' ? 'info' : 'warn', 'm03.coverage_cross_check', {
        checked_mints: out.checkedMints, pools_only_in_vendor: out.poolsOnlyInVendor.length, other_dex_pairs: out.otherDexPairs,
        known_pools_under_other_dex: knownUnderOther, status: out.status,
      });
      return out;
    },
  };
}
