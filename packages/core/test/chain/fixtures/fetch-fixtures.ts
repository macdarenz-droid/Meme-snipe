// Dev tool, not a test: collects real mainnet accounts and transactions for the decoder golden vectors.
// Run: node packages/core/test/chain/fixtures/fetch-fixtures.ts
// Public RPC (override with SOLANA_RPC), about 9 requests a second, with backoff on 429 and 5xx. Every fixture
// keeps its address or signature and the slot it was read at. Uses only Node built-ins and the decoders.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactRpc } from '../../redact-rpc.ts';
import {
  type Address,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
  NATIVE_MINT,
  NATIVE_MINT_2022,
  bondingCurveAddress,
  decodeBase58,
  decodeGlobalConfig,
  decodePool,
  decodeTransaction,
  fromBase64,
  recordFromRpc,
  transactionEvents,
  isCanonicalPool,
} from '../../../src/chain/index.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const OUT = dirname(fileURLToPath(import.meta.url));
const SPACING_MS = 110;
let last = 0;
let calls = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = last + SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    calls++;
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 7) throw new Error(`${method}: HTTP ${res.status} after ${attempt} retries`);
      const backoff = Math.min(30_000, 1000 * 2 ** attempt);
      console.error(`${method}: HTTP ${res.status}, waiting ${backoff} ms`);
      await sleep(backoff);
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result as T;
  }
}

interface AccountFixture {
  label: string;
  address: string;
  slot: number;
  owner: string;
  lamports: number;
  dataBase64: string;
  /** The RPC's own parse (jsonParsed) where the node has a parser (token mints, lookup tables), as an oracle. */
  parsed?: unknown;
}

interface TxFixture {
  label: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Position in the block. */
  txIndex: number;
  version: unknown;
  /** getTransaction encoding base64 (wire bytes + meta). */
  base64: unknown;
  /** getTransaction encoding json: the RPC's own parse of the message, as an oracle. */
  jsonMessage: unknown;
}

type RpcAccount = { context: { slot: number }; value: { owner: string; lamports: number; data: [string, string] | { parsed: unknown } } | null };

const accounts: AccountFixture[] = [];
const txs: TxFixture[] = [];
const haveTx = new Set<string>();
const haveAccount = new Set<string>();

async function addAccount(label: string, address: string, withParsed = false): Promise<AccountFixture | null> {
  if (haveAccount.has(address)) return accounts.find((a) => a.address === address) ?? null;
  const r = await rpc<RpcAccount>('getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
  if (!r.value) {
    console.error(`account ${label} ${address} not found`);
    return null;
  }
  const v = r.value;
  const fixture: AccountFixture = {
    label,
    address,
    slot: r.context.slot,
    owner: v.owner,
    lamports: v.lamports,
    dataBase64: (v.data as [string, string])[0],
  };
  if (withParsed) {
    const p = await rpc<RpcAccount>('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: r.context.slot }]);
    if (p.context.slot !== r.context.slot) {
      // Re-read raw at the parsed slot so both views describe the same state.
      const again = await rpc<RpcAccount>('getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized', minContextSlot: p.context.slot }]);
      if (again.context.slot !== p.context.slot) console.error(`slot drift on ${address}: ${again.context.slot} vs ${p.context.slot}`);
      fixture.slot = again.context.slot;
      fixture.dataBase64 = (again.value!.data as [string, string])[0];
    }
    fixture.parsed = p.value?.data;
  }
  accounts.push(fixture);
  haveAccount.add(address);
  console.log(`account ${label} ${address} (${fromBase64(fixture.dataBase64).length} bytes)`);
  return fixture;
}

// Fixture selection must not lean on the event decoder under test: a transaction qualifies by raw criteria (a pump or
// PumpSwap inner instruction that starts with the emit_cpi tag and an event discriminator from the pinned IDL).
// Field predicates (mayhem, negative reserves, pool address) then read the decoded event, and a decode error stops
// the fetch instead of silently dropping the transaction; the tests re-check those fields with an independent oracle.
const PINNED = JSON.parse(readFileSync(join(OUT, 'idl-pinned.json'), 'utf8')) as { programs: Record<string, { address: string; events: Record<string, number[]> }> };
const TAG = 'e445a52e51cb9a1d';
const DISCS = new Map<string, string>();
for (const p of Object.values(PINNED.programs)) for (const [name, d] of Object.entries(p.events)) DISCS.set(`${p.address}:${Buffer.from(d).toString('hex')}`, name);

const rawEventNames = (b: { transaction: unknown; meta: unknown }): string[] => {
  const meta = b.meta as { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] } | null; innerInstructions?: { instructions: { programIdIndex: number; data: string }[] }[] | null } | null;
  if (!meta || meta.err) return [];
  const tx = decodeTransaction(fromBase64((b.transaction as [string, string])[0]));
  const keys = [...tx.staticAccountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])];
  const names: string[] = [];
  for (const g of meta.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const hex = Buffer.from(decodeBase58(ix.data)).toString('hex');
      if (!hex.startsWith(TAG)) continue;
      const name = DISCS.get(`${keys[ix.programIdIndex]}:${hex.slice(16, 32)}`);
      if (name) names.push(name);
    }
  }
  return names;
};

const eventsOf = (signature: string, b: { slot: number; blockTime: number | null; transaction: unknown; meta: unknown }) => {
  if (rawEventNames(b).length === 0) return [];
  const evs = transactionEvents(recordFromRpc(signature, b as never));
  const names = evs.filter((e) => e.name !== 'other').map((e) => e.name);
  if (names.join() !== rawEventNames(b).join()) throw new Error(`${signature}: decoded events ${names} differ from raw ${rawEventNames(b)}`);
  return evs;
};


type BlockTx = { version: unknown; transaction: { signatures?: string[]; message: unknown } & unknown; meta: Record<string, any> | null };
type Block = { blockTime: number | null; transactions: BlockTx[] };
const blockCache = new Map<string, Block | null>();

async function getBlock(slot: number, encoding: 'base64' | 'json' = 'base64'): Promise<Block | null> {
  const k = `${slot}:${encoding}`;
  if (blockCache.has(k)) return blockCache.get(k)!;
  let b: Block | null = null;
  try {
    b = await rpc<Block | null>('getBlock', [slot, { encoding, transactionDetails: 'full', rewards: false, maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
  } catch (e) {
    console.error(`getBlock ${slot}: ${(e as Error).message}`);
  }
  blockCache.set(k, b);
  return b;
}

const slimMeta = (meta: Record<string, any> | null) => ({
  err: meta?.['err'] ?? null,
  loadedAddresses: meta?.['loadedAddresses'] ?? null,
  innerInstructions: meta?.['innerInstructions'] ?? null,
  logMessages: meta?.['logMessages'] ?? null,
  preTokenBalances: meta?.['preTokenBalances'] ?? null,
  postTokenBalances: meta?.['postTokenBalances'] ?? null,
});

function addBlockTx(label: string, signature: string, slot: number, blockTime: number | null, txIndex: number, t: BlockTx, jsonMessage: unknown) {
  if (haveTx.has(signature)) return;
  txs.push({
    label,
    signature,
    slot,
    blockTime,
    txIndex,
    version: t.version,
    base64: { slot, blockTime, version: t.version, transaction: t.transaction, meta: slimMeta(t.meta) },
    jsonMessage,
  });
  haveTx.add(signature);
  console.log(`tx ${label} ${signature} slot ${slot} #${txIndex} v=${String(t.version)}`);
}

/** Finds one transaction in its block (two getBlock calls, cached). */
async function blockTx(slot: number, signature: string) {
  const block = await getBlock(slot);
  if (!block) return null;
  const i = block.transactions.findIndex((t) => decodeTransaction(fromBase64((t.transaction as unknown as [string, string])[0])).signatures[0] === signature);
  if (i < 0) return null;
  const t = block.transactions[i]!;
  return {
    asRpc: { slot, blockTime: block.blockTime, transaction: t.transaction, meta: t.meta },
    add: async (label: string) => {
      const json = await getBlock(slot, 'json');
      const j = json!.transactions[i]!;
      addBlockTx(label, signature, slot, block.blockTime, i, t, (j.transaction as { message: unknown }).message);
    },
  };
}

/** Every run that wrote these files, oldest first (append modes add a run instead of replacing the record). */
let runs: { mode: string; finishedAt: string; calls: number; note?: string }[] = [];
let mode = 'full';

function write() {
  runs.push({ mode, finishedAt: new Date().toISOString(), calls });
  const meta = { rpc: redactRpc(RPC), runs };
  writeFileSync(join(OUT, 'accounts.json'), JSON.stringify({ meta, accounts }, null, 1) + '\n');
  writeFileSync(join(OUT, 'transactions.json'), JSON.stringify({ meta, transactions: txs }, null, 1) + '\n');
  console.log(`wrote ${accounts.length} accounts and ${txs.length} transactions with ${calls} RPC calls`);
}

async function signatures(address: string, limit: number, before?: string) {
  return rpc<{ signature: string; err: unknown; slot: number }[]>('getSignaturesForAddress', [address, { limit, ...(before && { before }), commitment: 'finalized' }]);
}


/** BOOST buy-and-burns are sent by the boost authority named in PumpSwap's GlobalConfig. */
async function addBoost() {
  const gc = await rpc<RpcAccount>('getAccountInfo', [PUMP_AMM_GLOBAL_CONFIG, { encoding: 'base64', commitment: 'finalized' }]);
  const authority = decodeGlobalConfig(fromBase64((gc.value!.data as [string, string])[0])).value.boostAuthority;
  if (!authority) throw new Error('GlobalConfig has no boost authority');
  for (const s of await signatures(authority, 25)) {
    if (s.err) continue;
    const found = await blockTx(s.slot, s.signature);
    if (!found) continue;
    if (eventsOf(s.signature, found.asRpc as never).some((e) => e.name === 'BoostBuyAndBurnEvent')) {
      await found.add('PumpSwap BoostBuyAndBurnEvent');
      return;
    }
  }
  console.error(`no BoostBuyAndBurnEvent among the boost authority's (${authority}) recent transactions`);
}

/** A curve's CompleteEvent is in the buy that filled it, just before the migration that reads the same curve. */
async function addComplete() {
  const migration = txs.find((t) => t.label.startsWith('migration'));
  if (!migration) throw new Error('no migration fixture');
  const ev = eventsOf(migration.signature, migration.base64 as never).find((e) => e.name === 'CompletePumpAmmMigrationEvent');
  if (!ev || ev.name !== 'CompletePumpAmmMigrationEvent') throw new Error('migration fixture has no migration event');
  for (const s of await signatures(ev.data.bondingCurve, 25)) {
    if (s.err) continue;
    const found = await blockTx(s.slot, s.signature);
    if (!found) continue;
    if (eventsOf(s.signature, found.asRpc as never).some((e) => e.name === 'CompleteEvent')) {
      await found.add('pump CompleteEvent (curve filled)');
      return;
    }
  }
  console.error(`no CompleteEvent among the recent transactions of curve ${ev.data.bondingCurve}`);
}

/** Re-reads the pool vaults with the RPC's jsonParsed view, and adds the bonding curve of the mayhem coin. */
async function addReview() {
  for (const v of accounts.filter((a) => a.label.includes('vault'))) {
    accounts.splice(accounts.indexOf(v), 1);
    haveAccount.delete(v.address);
    await addAccount(v.label, v.address, true);
  }
  const mayhem = txs.find((t) => t.label.includes('(mayhem)'));
  const create = mayhem && eventsOf(mayhem.signature, mayhem.base64 as never).find((e) => e.name === 'CreateEvent');
  if (!create || create.name !== 'CreateEvent') throw new Error('no mayhem create fixture');
  await addAccount('pump bonding curve (mayhem coin)', create.data.bondingCurve);
}

async function main() {
  const extra = { boost: addBoost, complete: addComplete, review: addReview } as Record<string, () => Promise<void>>;
  const only = process.argv[2] === undefined ? undefined : extra[process.argv[2]];
  if (process.argv[2] !== undefined && !only) throw new Error(`unknown mode ${process.argv[2]}; use boost, complete or review`);
  if (only) {
    // Adds one transaction kind to the existing fixtures without refetching the rest.
    mode = process.argv[2]!;
    const a = JSON.parse(readFileSync(join(OUT, 'accounts.json'), 'utf8')) as { meta: { runs?: typeof runs }; accounts: AccountFixture[] };
    runs = a.meta.runs ?? [];
    const t = JSON.parse(readFileSync(join(OUT, 'transactions.json'), 'utf8')) as { transactions: TxFixture[] };
    accounts.push(...a.accounts);
    for (const x of accounts) haveAccount.add(x.address);
    txs.push(...t.transactions);
    for (const x of txs) haveTx.add(x.signature);
    await only();
    write();
    return;
  }
  // Fixed accounts.
  await addAccount('pump Global', PUMP_GLOBAL);
  await addAccount('pump FeeConfig', PUMP_FEE_CONFIG);
  await addAccount('PumpSwap FeeConfig', PUMP_AMM_FEE_CONFIG);
  await addAccount('PumpSwap GlobalConfig', PUMP_AMM_GLOBAL_CONFIG);
  await addAccount('wrapped SOL mint (SPL Token)', NATIVE_MINT, true);
  await addAccount('USDC mint (SPL Token)', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', true);
  await addAccount('Token-2022 native mint', NATIVE_MINT_2022, true);
  // Token-2022 mints known to carry many extensions; each is kept only if it exists.
  for (const [label, mint] of [
    ['PYUSD (Token-2022)', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'],
    ['USDG (Token-2022)', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'],
    ['USD1 (Token-2022?)', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'],
    ['Fartcoin mint (old pump coin)', '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'],
  ] as const) {
    await addAccount(label, mint, true);
  }
  await addAccount('Fartcoin bonding curve (2024 layout)', bondingCurveAddress('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' as Address));

  // Transactions come from whole blocks (one getBlock call returns every transaction with its meta and its
  // position in the block), because the public RPC throttles getTransaction far harder than getBlock.
  const tip = await rpc<number>('getSlot', [{ commitment: 'finalized' }]);
  const want: Record<string, number> = { TradeEvent: 3, CreateEvent: 3, BuyEvent: 3, SellEvent: 3, failed: 1, negative: 2, mayhem: 1, legacy: 1, v0lookups: 1, v1: 1 };
  const need = () => Object.values(want).some((n) => n > 0);
  const createMints: string[] = [];
  const poolsSeen = new Set<string>();
  let nonCanonical = false;
  let canonicalPools = 0;
  for (let slot = tip - 2, scanned = 0; scanned < 40 && need(); slot--) {
    const block = await getBlock(slot);
    if (!block) continue;
    scanned++;
    const picks: { label: string; i: number }[] = [];
    block.transactions.forEach((t, i) => {
      const sig = t.transaction.signatures?.[0] ?? '';
      const asRpc = { slot, blockTime: block.blockTime, transaction: t.transaction as unknown as [string, string], meta: t.meta };
      const sigOf = sig || decodeTransaction(fromBase64((t.transaction as unknown as [string, string])[0])).signatures[0]!;
      const v = String(t.version);
      const touchesPump = (t.meta?.logMessages ?? []).some((l: string) => l.startsWith(`Program ${PUMP_PROGRAM} invoke`) || l.startsWith(`Program ${PUMP_AMM_PROGRAM} invoke`));
      if (t.meta?.err) {
        if (touchesPump && want['failed']! > 0) {
          picks.push({ label: 'pump failed transaction', i });
          want['failed']!--;
        }
        return;
      }
      const evs = touchesPump ? eventsOf(sigOf, asRpc as never) : [];
      let label: string | null = null;
      for (const e of evs) {
        if (e.name === 'CreateEvent' && e.data.isMayhemMode === true && want['mayhem']! > 0) {
          label = 'pump CreateEvent (mayhem)';
          want['mayhem']!--;
        } else if ((e.name === 'BuyEvent' || e.name === 'SellEvent') && e.data.virtualQuoteReserves !== undefined && e.data.virtualQuoteReserves < 0n && want['negative']! > 0) {
          label = `PumpSwap ${e.name} (negative virtual_quote_reserves ${e.data.virtualQuoteReserves})`;
          want['negative']!--;
        } else if ((want[e.name] ?? 0) > 0 && !label) {
          label = `${e.program === 'pump' ? 'pump' : 'PumpSwap'} ${e.name}`;
          want[e.name]!--;
        }
        if (e.name === 'CreateEvent' && label?.includes('CreateEvent')) createMints.push(e.data.mint);
        if ((e.name === 'BuyEvent' || e.name === 'SellEvent') && !poolsSeen.has(e.data.pool)) poolsSeen.add(e.data.pool);
        if (label) break;
      }
      if (!label && !touchesPump) {
        const lookups = v === '0' ? decodeTransaction(fromBase64((t.transaction as unknown as [string, string])[0])).addressTableLookups.length : 0;
        if (v === 'legacy' && want['legacy']! > 0) {
          label = 'legacy transaction';
          want['legacy']!--;
        } else if (v === '0' && lookups > 0 && want['v0lookups']! > 0) {
          label = `v0 transaction with ${lookups} lookup tables`;
          want['v0lookups']!--;
        } else if (v === '1' && want['v1']! > 0) {
          label = 'v1 transaction';
          want['v1']!--;
        }
      }
      if (label) picks.push({ label, i });
    });
    if (picks.length === 0) continue;
    const json = await getBlock(slot, 'json');
    for (const p of picks) {
      const t = block.transactions[p.i]!;
      const j = json!.transactions[p.i]!;
      const raw = (t.transaction as unknown as [string, string])[0];
      const sig = decodeTransaction(fromBase64(raw)).signatures[0]!;
      if (j.transaction.signatures?.[0] !== sig) throw new Error(`block ${slot} index ${p.i}: json and base64 disagree`);
      addBlockTx(p.label, sig, slot, block.blockTime, p.i, t, j.transaction.message);
      if (p.label.startsWith('v0')) {
        for (const l of decodeTransaction(fromBase64(raw)).addressTableLookups) await addAccount('address lookup table', l.accountKey, true);
      }
      if (p.label.includes('negative')) {
        const ev = eventsOf(sig, { slot, blockTime: block.blockTime, transaction: t.transaction, meta: t.meta } as never).find(
          (e) => (e.name === 'BuyEvent' || e.name === 'SellEvent') && (e.data.virtualQuoteReserves ?? 0n) < 0n,
        );
        if (ev && (ev.name === 'BuyEvent' || ev.name === 'SellEvent')) await addAccount('PumpSwap pool with negative virtual_quote_reserves at trade', ev.data.pool);
      }
    }
  }
  for (const [k, n] of Object.entries(want)) if (n > 0) console.error(`not found in the blocks scanned: ${k} (${n} short)`);

  for (const m of createMints.slice(0, 3)) {
    await addAccount('pump create_v2 mint', m, true);
    await addAccount('pump bonding curve (current layout)', bondingCurveAddress(m as Address));
  }

  // Pools seen in trades: keep two canonical ones (with their vaults) and one non-canonical if any.
  for (const pool of poolsSeen) {
    if (nonCanonical && canonicalPools >= 2) break;
    const r = await rpc<RpcAccount>('getAccountInfo', [pool, { encoding: 'base64', commitment: 'finalized' }]);
    if (!r.value) continue;
    const decoded = decodePool(fromBase64((r.value.data as [string, string])[0])).value;
    const canonical = isCanonicalPool(decoded, pool as Address);
    if (!canonical && !nonCanonical) {
      await addAccount('non-canonical PumpSwap pool', pool);
      nonCanonical = true;
    } else if (canonical && canonicalPools < 2) {
      await addAccount('canonical PumpSwap pool', pool);
      await addAccount('canonical pool base vault', decoded.poolBaseTokenAccount);
      await addAccount('canonical pool quote vault', decoded.poolQuoteTokenAccount);
      canonicalPools++;
    }
  }
  if (!nonCanonical) console.error('no non-canonical pool among the pools traded in the blocks scanned');

  // Migrations: the pump migration account signs every graduation (docs/research/venues.md 5.4). Read the
  // block of the most recent one, then a boost buy-and-burn on that pool (BOOST runs ~5 minutes after).
  const migrationSigs = await signatures('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', 30);
  let migrated: string | null = null;
  for (const s of migrationSigs) {
    if (s.err || migrated) continue;
    const found = await blockTx(s.slot, s.signature);
    if (!found) continue;
    const evs = eventsOf(s.signature, found.asRpc as never);
    const mig = evs.find((e) => e.name === 'CompletePumpAmmMigrationEvent');
    if (!mig || mig.name !== 'CompletePumpAmmMigrationEvent') continue;
    await found.add(`migration ${[...new Set(evs.map((e) => e.name))].join('+')}`);
    migrated = mig.data.pool;
  }
  if (migrated) {
    await addAccount('canonical PumpSwap pool (recent migration)', migrated);
  } else console.error('no migration found');
  await addBoost();
  await addComplete();


  write();
}

await main();
