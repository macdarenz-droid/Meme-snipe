// The 2026-10-06 config accounts (fixtures/mainnet/config) behind a fake reader, a fake clock and a log sink, shared by
// the A-M01-02 and A-M01-05 tests (card Z07).
import { strict as assert } from 'node:assert';
import type { Clock, Pubkey, Slot, UnixMs } from '@bot/types';
import { createDecoders, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import { createVenueConfigCache, createVenueModel, type AccountsReader, type RawAccount } from '../src/cache.ts';
import { ACCOUNTS, PROGRAMS } from '../src/constants.ts';
import { readJson } from './helpers.ts';

const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
assert.ok(idls.ok);
export const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });

type Fixture = { accounts: Array<{ pubkey: string; owner: string; data_base64: string; context_slot: number }> };
const raw = (name: string): RawAccount & { slot: number } => {
  const a = readJson<Fixture>(`fixtures/mainnet/config/${name}.json`).accounts[0] as Fixture['accounts'][number];
  return { owner: a.owner, data: new Uint8Array(Buffer.from(a.data_base64, 'base64')), slot: a.context_slot };
};
export const RAW = { curve: raw('fee_config_curve'), pumpswap: raw('fee_config_pumpswap'), global: raw('pumpswap_global_config'), pumpGlobal: raw('pump_global') };
const ORDER = [RAW.curve, RAW.pumpswap, RAW.global, RAW.pumpGlobal];

/** A reader replaying the 2026-10-06 config accounts; `fail` makes it time out, `edit` changes one account's bytes. */
export function fakeReader(): AccountsReader & { fail: boolean; accounts: Array<RawAccount | null>; reads: number } {
  const r = {
    fail: false, reads: 0, accounts: ORDER.map((a) => ({ owner: a.owner, data: a.data }) as RawAccount | null),
    async read(keys: readonly Pubkey[]) {
      r.reads++;
      assert.deepEqual(keys, [ACCOUNTS.feeConfigCurve, ACCOUNTS.feeConfigPumpSwap, ACCOUNTS.pumpSwapGlobalConfig, ACCOUNTS.pumpGlobal]);
      if (r.fail) return { ok: false as const, error: { code: 'E_TIMEOUT' } };
      return { ok: true as const, value: { contextSlot: BigInt(RAW.pumpswap.slot) as Slot, accounts: r.accounts } };
    },
  };
  return r;
}
export const fakeClock = (): Clock & { t: number } => {
  const c = { t: 1_790_000_000_000, kind: 'sim' as const, nowMs: () => c.t as UnixMs };
  return c;
};
export const logs: Array<{ level: string; code: string; fields: Record<string, unknown> }> = [];
export const log = { event: (level: string, code: string, fields: Readonly<Record<string, unknown>>) => { logs.push({ level, code, fields: { ...fields } }); } };

export async function liveCache() {
  const reader = fakeReader();
  const clock = fakeClock();
  const cache = createVenueConfigCache({ reader, decoder: decoders, clock, log });
  await cache.refresh();
  return { reader, clock, cache, model: createVenueModel(cache) };
}

