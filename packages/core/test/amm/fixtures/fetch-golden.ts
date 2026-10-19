// Dev tool, not a test: pulls recent pump.fun curve and PumpSwap trades from a public Solana RPC and writes
// their decoded events (plus the instruction that emitted them) to JSON fixtures for the golden-vector tests.
// Run: node packages/core/test/amm/fixtures/fetch-golden.ts [pages]
// Uses only Node built-ins. The public RPC is rate limited, so requests are spaced and retried.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactRpc } from '../../redact-rpc.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const DEFAULT_KEY = '11111111111111111111111111111111';
const FEE_CONFIG = { pump: '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt', amm: '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx' };
// Anchor emit_cpi tag, then the event discriminator (pump IDL / pump_amm IDL, pump-public-docs cb188ce).
const EVENT_IX_TAG = 'e445a52e51cb9a1d';
const DISC = {
  trade: 'bddb7fd34ee661ee',
  buy: '67f4521f2cf57777',
  sell: '3e2f370aa503dc2a',
} as const;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58decode = (s: string): Uint8Array => {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad base58 ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
};
const b58encode = (b: Uint8Array): string => {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = '1' + s; else break; }
  return s;
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

class Reader {
  private o = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  private take(n: number): Uint8Array {
    if (this.o + n > this.b.length) throw new RangeError('read past end');
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  private le(n: number): bigint { let v = 0n; const s = this.take(n); for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(s[i]!); return v; }
  u8 = () => Number(this.le(1));
  u16 = () => Number(this.le(2));
  u64 = () => this.le(8).toString();
  i64 = () => BigInt.asIntN(64, this.le(8)).toString();
  u128 = () => this.le(16).toString();
  i128 = () => BigInt.asIntN(128, this.le(16)).toString();
  bool = () => this.u8() !== 0;
  pubkey = () => b58encode(this.take(32));
  string = () => { const n = Number(this.le(4)); return Buffer.from(this.take(n)).toString('utf8'); };
  vec = <T>(f: () => T): T[] => { const n = Number(this.le(4)); return Array.from({ length: n }, f); };
  get remaining(): number { return this.b.length - this.o; }
}

type Fields = Record<string, unknown>;
// Field lists copied from the IDLs in pump-public-docs (commit cb188ce, 2026-09-29).
const decodeTrade = (r: Reader): Fields => ({
  mint: r.pubkey(), sol_amount: r.u64(), token_amount: r.u64(), is_buy: r.bool(), user: r.pubkey(), timestamp: r.i64(),
  virtual_sol_reserves: r.u64(), virtual_token_reserves: r.u64(), real_sol_reserves: r.u64(), real_token_reserves: r.u64(),
  fee_recipient: r.pubkey(), fee_basis_points: r.u64(), fee: r.u64(), creator: r.pubkey(), creator_fee_basis_points: r.u64(),
  creator_fee: r.u64(), track_volume: r.bool(), total_unclaimed_tokens: r.u64(), total_claimed_tokens: r.u64(),
  current_sol_volume: r.u64(), last_update_timestamp: r.i64(), ix_name: r.string(), mayhem_mode: r.bool(),
  cashback_fee_basis_points: r.u64(), cashback: r.u64(), buyback_fee_basis_points: r.u64(), buyback_fee: r.u64(),
  shareholders: r.vec(() => ({ address: r.pubkey(), share_bps: r.u16() })), quote_mint: r.pubkey(), quote_amount: r.u64(),
  virtual_quote_reserves: r.u64(), real_quote_reserves: r.u64(), holder_rewards_bps: r.u64(), holder_rewards: r.u64(),
});
const decodeBuy = (r: Reader): Fields => ({
  timestamp: r.i64(), base_amount_out: r.u64(), max_quote_amount_in: r.u64(), user_base_token_reserves: r.u64(),
  user_quote_token_reserves: r.u64(), pool_base_token_reserves: r.u64(), pool_quote_token_reserves: r.u64(),
  quote_amount_in: r.u64(), lp_fee_basis_points: r.u64(), lp_fee: r.u64(), protocol_fee_basis_points: r.u64(),
  protocol_fee: r.u64(), quote_amount_in_with_lp_fee: r.u64(), user_quote_amount_in: r.u64(), pool: r.pubkey(),
  user: r.pubkey(), user_base_token_account: r.pubkey(), user_quote_token_account: r.pubkey(),
  protocol_fee_recipient: r.pubkey(), protocol_fee_recipient_token_account: r.pubkey(), coin_creator: r.pubkey(),
  coin_creator_fee_basis_points: r.u64(), coin_creator_fee: r.u64(), track_volume: r.bool(), total_unclaimed_tokens: r.u64(),
  total_claimed_tokens: r.u64(), current_sol_volume: r.u64(), last_update_timestamp: r.i64(), min_base_amount_out: r.u64(),
  ix_name: r.string(), cashback_fee_basis_points: r.u64(), cashback: r.u64(), buyback_fee_basis_points: r.u64(),
  buyback_fee: r.u64(), virtual_quote_reserves: r.i128(), can_boost: r.bool(), base_supply: r.u64(),
  holder_rewards_bps: r.u64(), holder_rewards: r.u64(),
});
const decodeSell = (r: Reader): Fields => ({
  timestamp: r.i64(), base_amount_in: r.u64(), min_quote_amount_out: r.u64(), user_base_token_reserves: r.u64(),
  user_quote_token_reserves: r.u64(), pool_base_token_reserves: r.u64(), pool_quote_token_reserves: r.u64(),
  quote_amount_out: r.u64(), lp_fee_basis_points: r.u64(), lp_fee: r.u64(), protocol_fee_basis_points: r.u64(),
  protocol_fee: r.u64(), quote_amount_out_without_lp_fee: r.u64(), user_quote_amount_out: r.u64(), pool: r.pubkey(),
  user: r.pubkey(), user_base_token_account: r.pubkey(), user_quote_token_account: r.pubkey(),
  protocol_fee_recipient: r.pubkey(), protocol_fee_recipient_token_account: r.pubkey(), coin_creator: r.pubkey(),
  coin_creator_fee_basis_points: r.u64(), coin_creator_fee: r.u64(), cashback_fee_basis_points: r.u64(), cashback: r.u64(),
  buyback_fee_basis_points: r.u64(), buyback_fee: r.u64(), virtual_quote_reserves: r.i128(), can_boost: r.bool(),
  base_supply: r.u64(), holder_rewards_bps: r.u64(), holder_rewards: r.u64(),
});
const decodeFees = (r: Reader) => ({ lp_fee_bps: r.u64(), protocol_fee_bps: r.u64(), creator_fee_bps: r.u64() });
const decodeFeeConfig = (b: Uint8Array): Fields => {
  const r = new Reader(b.subarray(8));
  const tier = () => ({ market_cap_lamports_threshold: r.u128(), fees: decodeFees(r) });
  return { bump: r.u8(), admin: r.pubkey(), flat_fees: decodeFees(r), fee_tiers: r.vec(tier), stable_fee_tiers: r.vec(tier), exotic_flat_fees: decodeFees(r) };
};

// Program-derived addresses, to tell canonical PumpSwap pools (pool.creator = pump "pool-authority" PDA of the mint).
const P = 2n ** 255n - 19n;
const modpow = (b: bigint, e: bigint): bigint => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const D = (((-121665n * modpow(121666n, P - 2n)) % P) + P) % P;
const isOnCurve = (key: Uint8Array): boolean => {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(key[i]!);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const u = (y * y - 1n + P) % P;
  const v = (D * y * y + 1n) % P;
  const w = (u * modpow(v, P - 2n)) % P;
  if (w === 0n) return true;
  return modpow(w, (P - 1n) / 2n) === 1n;
};
const findPda = (seeds: Uint8Array[], program: string): string => {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump)).update(b58decode(program)).update('ProgramDerivedAddress');
    const key = new Uint8Array(h.digest());
    if (!isOnCurve(key)) return b58encode(key);
  }
  throw new Error('no PDA');
};

// pump_amm `Pool` account (IDL field order); pools created before a field existed are shorter, so trailing fields default.
const decodePool = (b: Uint8Array): Fields => {
  const r = new Reader(b.subarray(8));
  const f: Fields = { pool_bump: r.u8(), index: r.u16(), creator: r.pubkey(), base_mint: r.pubkey(), quote_mint: r.pubkey(), lp_mint: r.pubkey(), pool_base_token_account: r.pubkey(), pool_quote_token_account: r.pubkey(), lp_supply: r.u64(), coin_creator: r.pubkey() };
  f['is_mayhem_mode'] = r.remaining >= 1 ? r.bool() : false;
  f['is_cashback_coin'] = r.remaining >= 1 ? r.bool() : false;
  f['virtual_quote_reserves'] = r.remaining >= 16 ? r.i128() : '0';
  f['creator_fee_bps'] = r.remaining >= 8 ? r.u64() : '0';
  return f;
};

let last = 0;
const rpc = async (method: string, params: unknown[]): Promise<any> => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = last + 350 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
  throw new Error(`${method}: gave up after retries`);
};

type Captured = { venue: 'pump' | 'pumpswap'; kind: 'trade' | 'buy' | 'sell'; signature: string; slot: number; blockTime: number | null; eventIndex: number; ixData: string | null; event: Fields };

const capture = async (program: string, pages: number, source = program): Promise<Captured[]> => {
  const out: Captured[] = [];
  let before: string | undefined;
  for (let p = 0; p < pages; p++) {
    const sigs = (await rpc('getSignaturesForAddress', [source, { limit: 100, ...(before ? { before } : {}) }])) as { signature: string; err: unknown }[];
    if (sigs.length === 0) break;
    before = sigs[sigs.length - 1]!.signature;
    for (const s of sigs.filter((x) => x.err === null)) {
      const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'finalized' }]);
      if (!tx || tx.meta?.err) continue;
      const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      // Outer instructions followed by their inner ones, in execution order.
      const flat: { programId: string; data: Uint8Array }[] = [];
      tx.transaction.message.instructions.forEach((ix: any, i: number) => {
        flat.push({ programId: keys[ix.programIdIndex]!, data: b58decode(ix.data) });
        const inner = tx.meta.innerInstructions?.find((x: any) => x.index === i);
        for (const iix of inner?.instructions ?? []) flat.push({ programId: keys[iix.programIdIndex]!, data: b58decode(iix.data) });
      });
      let lastIx: string | null = null;
      let eventIndex = 0;
      for (const ix of flat) {
        if (ix.programId !== program) continue;
        const h = hex(ix.data);
        if (!h.startsWith(EVENT_IX_TAG)) { lastIx = h; continue; }
        const disc = h.slice(16, 32);
        const body = new Reader(ix.data.subarray(16));
        const kind = program === PUMP ? (disc === DISC.trade ? 'trade' : null) : disc === DISC.buy ? 'buy' : disc === DISC.sell ? 'sell' : null;
        if (!kind) continue;
        let event: Fields;
        try {
          event = kind === 'trade' ? decodeTrade(body) : kind === 'buy' ? decodeBuy(body) : decodeSell(body);
        } catch {
          console.error(`skipped an event in ${s.signature}: older layout`);
          continue;
        }
        out.push({ venue: program === PUMP ? 'pump' : 'pumpswap', kind, signature: s.signature, slot: tx.slot, blockTime: tx.blockTime, eventIndex: eventIndex++, ixData: lastIx, event });
      }
    }
    console.error(`${program.slice(0, 4)} page ${p + 1}: ${out.length} events`);
  }
  return out;
};

// Adds the current Pool account of every PumpSwap pool in the capture, with whether it is the canonical pump pool.
const enrichPools = async (file: string) => {
  const cap = JSON.parse(readFileSync(file, 'utf8')) as { pools?: Record<string, Fields>; events: Captured[] };
  const pools: Record<string, Fields> = cap.pools ?? {};
  for (const e of cap.events) {
    const pool = e.event['pool'] as string | undefined;
    if (!pool || pools[pool]) continue;
    const info = await rpc('getAccountInfo', [pool, { encoding: 'base64' }]);
    if (!info.value) continue;
    const decoded = decodePool(Buffer.from(info.value.data[0], 'base64'));
    const authority = findPda([new TextEncoder().encode('pool-authority'), b58decode(decoded['base_mint'] as string)], PUMP);
    pools[pool] = { slot: info.context.slot, canonical: decoded['creator'] === authority, ...decoded };
  }
  writeFileSync(file, JSON.stringify({ ...cap, pools }, null, 1));
  console.error(`pools: ${Object.keys(pools).length}`);
};

// Builds golden.json from raw-capture.json: every SOL-quoted, non-mayhem trade with its instruction arguments
// (the first two u64 after the 8-byte instruction discriminator) and the event fields the tests compare.
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CURVE_KEEP = ['mint', 'sol_amount', 'token_amount', 'is_buy', 'virtual_sol_reserves', 'virtual_token_reserves', 'real_sol_reserves', 'real_token_reserves', 'fee_basis_points', 'fee', 'creator', 'creator_fee_basis_points', 'creator_fee', 'ix_name', 'mayhem_mode', 'buyback_fee_basis_points', 'buyback_fee', 'quote_mint'];
const POOL_DROP = ['user', 'user_base_token_account', 'user_quote_token_account', 'protocol_fee_recipient', 'protocol_fee_recipient_token_account', 'total_unclaimed_tokens', 'total_claimed_tokens', 'current_sol_volume', 'last_update_timestamp', 'track_volume'];
const ixArgs = (h: string | null): [string, string] | null => {
  if (!h || h.length < 48) return null;
  const b = Buffer.from(h, 'hex');
  return [b.readBigUInt64LE(8).toString(), b.readBigUInt64LE(16).toString()];
};
const curate = (dir: string) => {
  const cap = JSON.parse(readFileSync(join(dir, 'raw-capture.json'), 'utf8')) as { rpc: string; fetchedAt: string; pools: Record<string, Fields>; events: Captured[] };
  const curve = cap.events.filter((e) => e.venue === 'pump' && e.event['mayhem_mode'] === false && [DEFAULT_KEY, WSOL].includes(e.event['quote_mint'] as string))
    .flatMap((e) => { const args = ixArgs(e.ixData); return args ? [{ signature: e.signature, slot: e.slot, ixName: e.event['ix_name'], ixDisc: e.ixData!.slice(0, 16), args, event: Object.fromEntries(CURVE_KEEP.map((k) => [k, e.event[k]])) }] : []; });
  const pumpswap = cap.events.filter((e) => e.venue === 'pumpswap')
    .flatMap((e) => {
      const pool = cap.pools[e.event['pool'] as string];
      const args = ixArgs(e.ixData);
      // USDC pools pay stable tiers, which the quote module does not model; other quote mints pay the exotic schedule.
      if (!pool || !args || pool['is_mayhem_mode'] || pool['quote_mint'] === USDC) return [];
      return [{ signature: e.signature, slot: e.slot, eventIndex: e.eventIndex, kind: e.kind, ixName: e.kind === 'sell' ? 'sell' : e.event['ix_name'], ixDisc: e.ixData!.slice(0, 16), args,
        event: Object.fromEntries(Object.entries(e.event).filter(([k]) => !POOL_DROP.includes(k))),
        pool: { address: e.event['pool'], canonical: pool['canonical'], quote: pool['quote_mint'] === WSOL ? 'sol' : 'exotic', quote_mint: pool['quote_mint'], creator_fee_bps: pool['creator_fee_bps'], base_mint: pool['base_mint'], account_slot: pool['slot'] } }];
    });
  const old = (() => { try { return JSON.parse(readFileSync(join(dir, 'golden.json'), 'utf8')) as { vaultDeltas?: unknown[] }; } catch { return {}; } })();
  const out = { vaultDeltas: old.vaultDeltas ?? [], source: redactRpc(cap.rpc), fetchedAt: cap.fetchedAt, selection: 'every successful non-mayhem trade in the captured pages: SOL-quoted curves; PumpSwap pools quoted in SOL or an exotic mint (USDC excluded)', curve, pumpswap };
  writeFileSync(join(dir, 'golden.json'), JSON.stringify(out, null, 1));
  console.error(`golden: ${curve.length} curve, ${pumpswap.length} pumpswap`);
};

const main = async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  if (process.argv[2] === 'curate') return curate(dir);
  if (process.argv[2] === 'vault-deltas') {
    // Real vault balances around single-trade transactions (token balances in the transaction meta), so the tests can
    // check where fees land: every v2-instruction trade plus the first N others, one trade per transaction and pool.
    const file = join(dir, 'golden.json');
    const golden = JSON.parse(readFileSync(file, 'utf8')) as { pumpswap: { signature: string; eventIndex: number; ixDisc: string; pool: { address: string } }[]; vaultDeltas?: unknown[] };
    const raw = JSON.parse(readFileSync(join(dir, 'raw-capture.json'), 'utf8')) as { pools: Record<string, Fields> };
    const V2 = ['5df6823ce7e940b2', 'c2ab1c46684d5b2f', 'b817ee6167c5d33d'];
    const single = golden.pumpswap.filter((v) => golden.pumpswap.filter((w) => w.signature === v.signature).length === 1);
    const pick = [...single.filter((v) => V2.includes(v.ixDisc)), ...single.filter((v) => !V2.includes(v.ixDisc)).slice(0, Number(process.argv[3] ?? '20'))];
    const deltas = [];
    for (const v of pick) {
      const pool = raw.pools[v.pool.address]!;
      const tx = await rpc('getTransaction', [v.signature, { maxSupportedTransactionVersion: 1, encoding: 'json' }]);
      const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const bal = (list: any[], account: string) => list.find((b) => keys[b.accountIndex] === account)?.uiTokenAmount.amount as string | undefined;
      const q = pool['pool_quote_token_account'] as string;
      const b = pool['pool_base_token_account'] as string;
      deltas.push({ signature: v.signature, eventIndex: v.eventIndex, quotePre: bal(tx.meta.preTokenBalances, q), quotePost: bal(tx.meta.postTokenBalances, q), basePre: bal(tx.meta.preTokenBalances, b), basePost: bal(tx.meta.postTokenBalances, b) });
    }
    writeFileSync(file, JSON.stringify({ ...golden, vaultDeltas: deltas }, null, 1));
    console.error(`vault deltas: ${deltas.length}`);
    return;
  }
  if (process.argv[2] === 'find-completions') {
    // Finds the buys that completed recently graduated curves: recent migrations (withdraw authority) -> mint ->
    // bonding curve -> the TradeEvent leaving real_token_reserves at 0. Appends them to raw-capture.json.
    const file = join(dir, 'raw-capture.json');
    const cap = JSON.parse(readFileSync(file, 'utf8')) as { events: Captured[] };
    const seen = new Set(cap.events.map((e) => `${e.signature}:${e.eventIndex}:${e.venue}`));
    const migrations = (await rpc('getSignaturesForAddress', ['39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', { limit: Number(process.argv[3] ?? '30') }])) as { signature: string; err: unknown }[];
    const mints = new Set<string>();
    for (const m of migrations.filter((x) => x.err === null)) {
      const tx = await rpc('getTransaction', [m.signature, { maxSupportedTransactionVersion: 1, encoding: 'json' }]);
      for (const b of tx?.meta?.postTokenBalances ?? []) if (typeof b.mint === 'string' && b.mint.endsWith('pump')) mints.add(b.mint);
    }
    const found: Captured[] = [];
    for (const mint of mints) {
      const curve = findPda([new TextEncoder().encode('bonding-curve'), b58decode(mint)], PUMP);
      const events = await capture(PUMP, 1, curve);
      found.push(...events.filter((e) => e.event['real_token_reserves'] === '0' && e.event['mint'] === mint && !seen.has(`${e.signature}:${e.eventIndex}:${e.venue}`)));
    }
    for (const e of found) console.error(`completion ${e.signature} ${e.event['ix_name']}`);
    writeFileSync(file, JSON.stringify({ ...cap, events: [...cap.events, ...found] }, null, 1));
    return;
  }
  if (process.argv[2] === 'add-pool' || process.argv[2] === 'more-curve') {
    // Appends one pool's recent trades (e.g. a pool found with negative virtual_quote_reserves), or N more pages of curve trades.
    const file = join(dir, 'raw-capture.json');
    const cap = JSON.parse(readFileSync(file, 'utf8')) as { events: Captured[] };
    const seen = new Set(cap.events.map((e) => `${e.signature}:${e.eventIndex}:${e.venue}`));
    const fresh = process.argv[2] === 'add-pool' ? await capture(PUMP_AMM, 1, process.argv[3]!) : await capture(PUMP, Number(process.argv[3] ?? '1'));
    const added = fresh.filter((e) => !seen.has(`${e.signature}:${e.eventIndex}:${e.venue}`));
    writeFileSync(file, JSON.stringify({ ...cap, events: [...cap.events, ...added] }, null, 1));
    console.error(`added ${added.length} events`);
    return enrichPools(file);
  }
  if (process.argv[2] === 'pda-selftest') {
    // Known addresses from the research notes: pump Global and the PumpSwap FeeConfig.
    console.log(findPda([new TextEncoder().encode('global')], PUMP) === '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
      findPda([new TextEncoder().encode('fee_config'), b58decode(PUMP_AMM)], 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ') === FEE_CONFIG.amm);
    return;
  }
  if (process.argv[2] === 'enrich') return enrichPools(join(dir, 'raw-capture.json'));
  const pages = Number(process.argv[2] ?? '1');
  const feeConfigs: Fields = {};
  for (const [name, address] of Object.entries(FEE_CONFIG)) {
    const info = await rpc('getAccountInfo', [address, { encoding: 'base64' }]);
    const slot = info.context.slot as number;
    feeConfigs[name] = { address, slot, ...decodeFeeConfig(Buffer.from(info.value.data[0], 'base64')) };
  }
  const events = [...(await capture(PUMP, pages)), ...(await capture(PUMP_AMM, pages))];
  writeFileSync(join(dir, 'raw-capture.json'), JSON.stringify({ rpc: redactRpc(RPC), fetchedAt: new Date().toISOString(), feeConfigs, events }, null, 1));
  console.error(`wrote ${events.length} events`);
  await enrichPools(join(dir, 'raw-capture.json'));
};

await main();
