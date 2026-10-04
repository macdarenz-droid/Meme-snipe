// WATCH-1's coherent snapshot on real mainnet data (fixtures/watch-snapshot.json, fetch-watch-fixture.ts): one read of
// an active canonical pool, and the pool's next swap. Quoted from the snapshot alone, that swap's fees and amounts match
// what the chain charged.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { poolBuyExactBase, poolSell } from '../../core/src/amm/index.ts';
import { type Address, decodeAddressBytes, decodeMint, decodePool, fromBase64, recordFromRpc, transactionEvents, type RpcTransactionBase64 } from '../../core/src/chain/index.ts';
import { CHAIN_ACCOUNTS as CHAIN } from '../../core/test/gates/world.ts';
import { decodeSnapshot, type ReadAccount, snapshotAddresses } from '../src/run/snapshot.ts';
import { type CarryFact, type SnapshotFact, chooseMarket, snapshotWins } from '../src/engine/strategy.ts';
import { parsePool } from '../../core/src/gates/index.ts';
import { MINT as WORLD_MINT, passingFacts } from '../../core/test/gates/world.ts';
import { poolKey } from '../../core/src/gates/index.ts';
import { PositionWatch } from '../src/run/watch.ts';
import { FakeSocketHub, rpcHandler, scriptedHttp } from '../src/providers/index.ts';
import { ALCHEMY_FREE, ManualTimers } from '../src/scheduler/index.ts';
import { CreditBook, LiveProviders } from '../src/run/sources.ts';
import { testSecrets } from './helpers.ts';
import { tempState } from './worker-harness.ts';
import { casesHash } from './fixtures/fixture-hash.ts';

const { meta, ...F } = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'watch-snapshot.json'), 'utf8')) as {
  meta: { sha256: string };
  pool: string; mint: string; slot: number;
  accounts: { address: string; owner: string | null; dataBase64: string | null }[];
  next: RpcTransactionBase64 & { signature: string };
};
const read = (): ReadAccount[] => F.accounts.map((a) => (a.owner === null || a.dataBase64 === null ? null : { owner: a.owner, data: fromBase64(a.dataBase64) }));
const swap = transactionEvents(recordFromRpc(F.next.signature, F.next)).find((e) => e.program === 'pump_amm' && (e.name === 'BuyEvent' || e.name === 'SellEvent'))!;
const ev = swap.data as unknown as Record<string, bigint | string>;

describe('the coherent snapshot (WATCH-1)', () => {
  it('the fixture matches its content hash', () => {
    expect(meta.sha256).toBe(casesHash(F));
  });

  it('reads pool, vaults, mint, GlobalConfig and FeeConfig in that order', () => {
    const vaults = F.accounts.slice(1, 3).map((a) => a.address);
    expect(snapshotAddresses(F.pool, vaults[0]!, vaults[1]!, F.mint)).toEqual(F.accounts.map((a) => a.address));
  });

  it('gives the reserves the next swap started from, and quotes that swap exactly as the chain charged it', () => {
    const r = decodeSnapshot(F.mint, F.pool, BigInt(F.slot), read());
    if (!r.ok) throw new Error(r.reason);
    const { state, ctx } = r.snapshot;
    expect(r.snapshot.slot).toBe(BigInt(F.slot));
    expect(state).toEqual({ baseReserve: ev['poolBaseTokenReserves'], quoteVault: ev['poolQuoteTokenReserves'], virtualQuoteReserves: ev['virtualQuoteReserves'] });
    expect(ctx).toMatchObject({ canonical: true, quote: 'sol', creatorFeeCharged: true, coin: { mayhemMode: false, transferFee: false, transferHook: false }, buybackFeeBps: Number(ev['buybackFeeBasisPoints']) });
    // The market cap that picks the fee tier uses the mint's live supply: the program's own figure in the event.
    expect(ctx.baseSupply).toBe(ev['baseSupply']);
    expect(ctx.creatorFeeOverride).toBeUndefined();
    // The swap's own instruction family (only where fees land differs; prices do not).
    const at = { ...ctx, instruction: String(ev['ixName']).endsWith('_v2') ? 'v2' as const : 'v1' as const };
    const q = swap.name === 'BuyEvent' ? poolBuyExactBase(state, ev['baseAmountOut'] as bigint, at) : poolSell(state, ev['baseAmountIn'] as bigint, at);
    if (!q.ok) throw new Error(q.detail);
    expect({ lp: q.trade.lpFee, protocol: q.trade.protocolFee, creator: q.trade.creatorFee, buyback: q.trade.buybackFee, user: q.trade.userQuote }).toEqual({
      lp: ev['lpFee'], protocol: ev['protocolFee'], creator: ev['coinCreatorFee'], buyback: ev['buybackFee'],
      user: swap.name === 'BuyEvent' ? ev['userQuoteAmountIn'] : ev['userQuoteAmountOut'],
    });
  });

  it('a pool with its own creator fee: the override comes from the pool account', () => {
    const accts = read();
    const data = accts[0]!.data.slice();
    // creator_fee_bps (u64) follows virtual_quote_reserves (i128) at 245: checked by decoding the edited bytes.
    new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(261, 150n, true);
    expect(decodePool(data).value.creatorFeeBps).toBe(150n);
    const r = decodeSnapshot(F.mint, F.pool, BigInt(F.slot), [{ owner: accts[0]!.owner, data }, ...accts.slice(1)]);
    expect(r.ok && r.snapshot.ctx.creatorFeeOverride).toBe(150);
  });

  it('mayhem mode, a pool with no coin creator and a non-SOL quote are read from the pool account', () => {
    const accts = read();
    const edit = (offset: number, bytes: Uint8Array) => {
      const data = accts[0]!.data.slice();
      data.set(bytes, offset);
      return [{ owner: accts[0]!.owner, data }, ...accts.slice(1)];
    };
    const slot = BigInt(F.slot);
    // Offsets checked by decoding the edited bytes: coin_creator at 211, is_mayhem_mode at 243, quote_mint at 75.
    const mayhem = edit(243, new Uint8Array([1]));
    expect(decodePool(mayhem[0]!.data).value.isMayhemMode).toBe(true);
    expect(decodeSnapshot(F.mint, F.pool, slot, mayhem)).toMatchObject({ ok: true, snapshot: { ctx: { coin: { mayhemMode: true } } } });
    const noCreator = edit(211, new Uint8Array(32));
    expect(decodePool(noCreator[0]!.data).value.coinCreator).toBe('11111111111111111111111111111111');
    expect(decodeSnapshot(F.mint, F.pool, slot, noCreator)).toMatchObject({ ok: true, snapshot: { ctx: { creatorFeeCharged: false } } });
    const usdc = edit(75, decodeAddressBytes('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
    expect(decodePool(usdc[0]!.data).value.quoteMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(decodeSnapshot(F.mint, F.pool, slot, usdc)).toMatchObject({ ok: false, reason: expect.stringMatching(/is not SOL/) });
  });

  it('Token-2022 flags come from the mint\'s extensions as they are now: configured but inactive is not a fee or a hook', () => {
    const accts = read();
    const pyusd = CHAIN.find((a) => a.label === 'PYUSD (Token-2022)')!;
    const raw = fromBase64(pyusd.dataBase64);
    const flags = (mint: Uint8Array) => {
      const r = decodeSnapshot(F.mint, F.pool, BigInt(F.slot), accts.map((a, i) => (i === 3 ? { owner: pyusd.owner, data: mint } : a)));
      if (!r.ok) throw new Error(r.reason);
      return r.snapshot.ctx.coin;
    };
    // PYUSD: a transfer-fee config at 0 bps and a hook with no program.
    expect(flags(raw)).toEqual({ mayhemMode: false, transferFee: false, transferHook: false });
    const ext = (data: Uint8Array, kind: string) => decodeMint(data, pyusd.owner as Address).extensions.find((e) => e.kind === kind) as unknown as { fields: Record<string, unknown> };
    // The newer fee set to 1%: its TLV header is type 1, length 108; the newer fee's bps is the record's last u16.
    const fee = raw.slice();
    const at = [...fee.keys()].find((k) => fee[k] === 1 && fee[k + 1] === 0 && fee[k + 2] === 108 && fee[k + 3] === 0 && k > 165)!;
    new DataView(fee.buffer).setUint16(at + 4 + 106, 100, true);
    expect((ext(fee, 'TransferFeeConfig').fields['newerTransferFee'] as { transferFeeBasisPoints: number }).transferFeeBasisPoints).toBe(100);
    expect(flags(fee)).toMatchObject({ transferFee: true, transferHook: false });
    // A hook program set: TLV type 14, length 64 (authority, then the program id).
    const hook = raw.slice();
    const h = [...hook.keys()].find((k) => hook[k] === 14 && hook[k + 1] === 0 && hook[k + 2] === 64 && hook[k + 3] === 0 && k > 165)!;
    hook.set(decodeAddressBytes(F.pool), h + 4 + 32);
    expect(ext(hook, 'TransferHook').fields['programId']).toBe(F.pool);
    expect(flags(hook)).toMatchObject({ transferFee: false, transferHook: true });
  });

  it('a FeeConfig not owned by pump-fees is refused', () => {
    const accts = read();
    expect(decodeSnapshot(F.mint, F.pool, BigInt(F.slot), accts.map((a, i) => (i === 5 ? { owner: accts[0]!.owner, data: a!.data } : a)))).toMatchObject({ ok: false, reason: expect.stringMatching(/pump-fees/) });
  });

  it('refuses a read it cannot trust: a missing account, another mint, vaults that are not the pool\'s, a non-SOL quote', () => {
    const accts = read();
    const slot = BigInt(F.slot);
    expect(decodeSnapshot(F.mint, F.pool, slot, accts.slice(0, 5))).toMatchObject({ ok: false });
    expect(decodeSnapshot(F.mint, F.pool, slot, accts.map((a, i) => (i === 2 ? null : a)))).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) });
    expect(decodeSnapshot(F.accounts[0]!.address, F.pool, slot, accts)).toMatchObject({ ok: false, reason: expect.stringMatching(/base mint/) });
    expect(decodeSnapshot(F.mint, F.pool, slot, [accts[0]!, accts[2]!, accts[1]!, ...accts.slice(3)])).toMatchObject({ ok: false, reason: expect.stringMatching(/vaults/) });
    expect(decodeSnapshot(F.mint, F.accounts[1]!.address, slot, accts)).toMatchObject({ ok: false, reason: expect.stringMatching(/vaults/) });
    expect(decodeSnapshot(F.mint, F.pool, slot, accts.map((a, i) => (i === 5 ? { owner: a!.owner, data: accts[4]!.data } : a)))).toMatchObject({ ok: false, reason: expect.stringMatching(/undecodable/) });
  });
});

describe('the second path (LiveProviders.watchRead)', () => {
  it('reads every account in one getMultipleAccounts at confirmed, on Alchemy, at P0, charged 20 CU, and still reads at the budget halt', async () => {
    const timers = new ManualTimers(0);
    const http = scriptedHttp(rpcHandler((method) => (method === 'getMultipleAccounts' ? { context: { slot: F.slot }, value: F.accounts.map((a) => (a.dataBase64 === null ? null : { owner: a.owner, lamports: 1, data: [a.dataBase64, 'base64'], executable: false, rentEpoch: 0 })) } : undefined)));
    const providers = new LiveProviders({ tradeStreams: false, secrets: testSecrets, http, factory: new FakeSocketHub().factory, credits: new CreditBook(tempState(), timers) });
    const r = await providers.watchRead()(F.accounts.map((a) => a.address));
    expect(r.slot).toBe(BigInt(F.slot));
    expect(decodeSnapshot(F.mint, F.pool, r.slot, r.accounts)).toMatchObject({ ok: true });
    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]!.url).host).toMatch(/alchemy/);
    const body = JSON.parse(http.calls[0]!.body ?? '{}') as { method: string; params: [string[], { commitment: string }] };
    expect(body.method).toBe('getMultipleAccounts');
    expect(body.params[0]).toEqual(F.accounts.map((a) => a.address));
    expect(body.params[1].commitment).toBe('confirmed');
    const st = providers.alchemy.status();
    expect(st.granted).toEqual([0 + 1, 0, 0, 0]);
    expect(st.creditsUsed).toBe(20);
    expect(providers.helius.status().granted).toEqual([0, 0, 0, 0]);
    // The month's budget at its halt share: every other class is refused, the exit's price read still goes.
    providers.alchemy.resetBudget(ALCHEMY_FREE.budget!.monthlyCredits * ALCHEMY_FREE.budget!.haltShare);
    expect(providers.alchemy.halted).toBe(true);
    const again = await providers.watchRead()(F.accounts.map((a) => a.address));
    expect(again.slot).toBe(BigInt(F.slot));
    expect(providers.alchemy.status().granted).toEqual([2, 0, 0, 0]);
  });
});

describe('which market is newer (review of #87)', () => {
  const snap = (slot: bigint, atMs: number): SnapshotFact => ({ pool: 'p', slot, atMs, state: { baseReserve: 1n, quoteVault: 1n, virtualQuoteReserves: 0n }, ctx: {} as SnapshotFact['ctx'] });
  it('by slot when both carry one, the receipt time only breaking a tie or standing in for a pool fact with no slot', () => {
    expect(snapshotWins(snap(10n, 1_000), { slot: 9n, receivedAt: 5_000 })).toBe(true);
    expect(snapshotWins(snap(9n, 9_000), { slot: 10n, receivedAt: 1_000 })).toBe(false);
    expect(snapshotWins(snap(10n, 2_000), { slot: 10n, receivedAt: 1_000 })).toBe(true);
    expect(snapshotWins(snap(10n, 1_000), { slot: 10n, receivedAt: 1_000 })).toBe(false);
    expect(snapshotWins(snap(1n, 2_000), { slot: null, receivedAt: 1_000 })).toBe(true);
    expect(snapshotWins(snap(1n, 1_000), null)).toBe(true);
  });
});

describe('the watch\'s read latency (review of #87)', () => {
  it('an answer later than the allowed latency is refused: the alert is raised and nothing is put on the feed', async () => {
    const timers = new ManualTimers(0);
    const put: unknown[] = [];
    const alerts: string[] = [];
    const accounts = read();
    const w = new PositionWatch({
      timers, everyMs: 200, staleMs: 500, latencyMs: 400,
      held: () => [{ mint: F.mint, pool: F.pool }], marketAt: () => null,
      read: (addresses) => new Promise((r) => timers.setTimeout(() => r({ slot: BigInt(F.slot), accounts: addresses.length === 1 ? [accounts[0]!] : accounts }), 450)),
      put: (s) => void put.push(s), alert: (_m, why) => void alerts.push(why), cleared: () => undefined,
    });
    w.start();
    for (let k = 0; k < 20; k++) {
      timers.advance(100);
      await new Promise<void>((r) => setImmediate(r));
    }
    w.stop();
    expect(put).toEqual([]);
    expect(alerts).toEqual(['no answer within 400 ms']);
  });

  it('a position that opens is read at once, however fresh its market; never twice at a time, and not once stopped', async () => {
    const timers = new ManualTimers(0);
    const put: unknown[] = [];
    const accounts = read();
    const reads: number[] = [];
    const w = new PositionWatch({
      timers, everyMs: 200, staleMs: 500, latencyMs: 400,
      held: () => [{ mint: F.mint, pool: F.pool }], marketAt: () => timers.now(),
      read: (addresses) => {
        reads.push(timers.now());
        return Promise.resolve({ slot: BigInt(F.slot), accounts: addresses.length === 1 ? [accounts[0]!] : accounts });
      },
      put: (s) => void put.push(s), alert: () => undefined, cleared: () => undefined,
    });
    w.start();
    timers.advance(1_000);
    await new Promise<void>((r) => setImmediate(r));
    // A fresh market: the timer reads nothing.
    expect(reads).toEqual([]);
    w.opened(F.mint, F.pool);
    w.opened(F.mint, F.pool);
    for (let k = 0; k < 5; k++) await new Promise<void>((r) => setImmediate(r));
    // One read for the vault layout, then the coherent read, both at the open; the second call found it in flight.
    expect(reads).toEqual([1_000, 1_000]);
    expect(put).toHaveLength(1);
    w.opened(F.mint, null);
    w.stop();
    w.opened(F.mint, F.pool);
    for (let k = 0; k < 5; k++) await new Promise<void>((r) => setImmediate(r));
    expect(reads).toHaveLength(2);
  });

  it('chooseMarket: a carry moves the pool fact to its moment only for the same reserves, never a flagged fact, never past a newer disagreeing snapshot (WATCH-1c)', () => {
    const facts = passingFacts();
    const raw = facts.get(poolKey(WORLD_MINT))!.value;
    const pool = parsePool(raw)!;
    const state = { baseReserve: pool.baseVault, quoteVault: pool.quoteVault, virtualQuoteReserves: pool.pool.virtualQuoteReserves ?? 0n };
    const slot = pool.obs.slot ?? 0n;
    const carry = (o: Partial<CarryFact> = {}): CarryFact => ({ pool: pool.address, slot: slot + 3n, state, obs: { receivedAt: pool.obs.receivedAt + 1_200 }, ...o });
    expect(chooseMarket(pool, null, carry())).toEqual({ kind: 'pool', pool, atMs: pool.obs.receivedAt + 1_200, carried: true });
    // Other reserves (a carry of a state the pool fact is not), another pool, an older carry: the pool fact's own moment.
    for (const c of [carry({ state: { ...state, quoteVault: state.quoteVault + 1n } }), carry({ pool: 'x' }), carry({ obs: { receivedAt: pool.obs.receivedAt - 1 } })]) {
      expect(chooseMarket(pool, null, c)).toEqual({ kind: 'pool', pool, atMs: pool.obs.receivedAt, carried: false });
    }
    // A flagged fact is never carried.
    const flagged = parsePool({ ...(raw as object), obs: { ...pool.obs, quality: ['partial'] } })!;
    expect(chooseMarket(flagged, null, carry())).toEqual({ kind: 'flagged', pool: flagged });
    // A snapshot newer than the pool fact: agreeing, the carry still outranks it; disagreeing, the snapshot is the market.
    const snap = (q: bigint): SnapshotFact => ({ pool: pool.address, slot: slot + 1n, atMs: pool.obs.receivedAt + 500, state: { ...state, quoteVault: q }, ctx: {} as SnapshotFact['ctx'] });
    expect(chooseMarket(pool, snap(state.quoteVault), carry())).toMatchObject({ kind: 'pool', carried: true });
    expect(chooseMarket(pool, snap(state.quoteVault - 1n), carry())).toMatchObject({ kind: 'snapshot' });
  });
});
