// REPLAY-1000: account state as of a past slot, exact or refused. The rule behind every rebuild: an account's data
// changes only in a successful transaction that includes it. So
// - an account no successful transaction touched after the as-of slot is today's account (read once, `snapshot`);
// - a pool's vaults and virtual reserves come from its last transaction at or before the slot (pool-state.ts,
//   validated against every next trade's own pre-trade fields);
// - a mint's supply is the sum of its transactions' token balance changes up to the slot (no mint authority, so only
//   burns move it); its other fields cannot change once its authorities are revoked;
// - the LP mint and the PumpSwap configs are today's when nothing changed them after the slot (their writers are
//   known: the pool's deposits and withdrawals, the configs' single admin);
// - a holder's token account comes from the holder rebuild (holders.ts).
// Anything else is refused, and the bot refuses the coin itself (fail closed).
import {
  NATIVE_MINT, PUMP_AMM_GLOBAL_CONFIG, decodeBase58, recordFromRpc, transactionEvents, type RpcTransactionBase64, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, decodePool, fromBase64, toBase64,
  type Address,
} from '../../../packages/core/src/chain/index.ts';
import { createHash } from 'node:crypto';
import { decodeTransaction } from '../../../packages/core/src/chain/message.ts';
import { PUMP_AMM_FEE_CONFIG } from '../../../packages/worker/src/run/snapshot.ts';
import type { PublicRpc, RawSig } from '../rpc.ts';
import type { ChainView } from './chain.ts';
import type { HolderBook } from './holders.ts';
import { accountKeys, poolAfter, type RpcTx } from './pool-state.ts';
import { Refused } from './rpc-world.ts';

/** The single admin of both FeeConfigs and the PumpSwap GlobalConfig (docs/research/venues.md 2.7). */
export const CONFIG_ADMIN = 'FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF';

export interface RawAccount {
  readonly data: [string, 'base64'];
  readonly executable: boolean;
  readonly lamports: number;
  readonly owner: string;
  readonly rentEpoch: number;
  readonly space: number;
}

interface Snapshot {
  readonly slot: number;
  readonly value: RawAccount | null;
}

/** Pool layout offsets (packages/core/src/chain/pump-amm.ts PoolLayout, after the 8-byte discriminator). */
const POOL_LP_SUPPLY = 203;
const POOL_VIRTUAL = 245;
/** Token account amount; mint supply (SPL Token and Token-2022 base layouts). */
const TOKEN_AMOUNT = 64;
const TOKEN_IS_NATIVE = 109;
const MINT_SUPPLY = 36;
/** Pool.coin_creator (after lp_supply). */
const POOL_COIN_CREATOR = 211;

/** PumpSwap instructions that may run on a pool after its creation without changing anything but reserves and fees. */
export const KNOWN_POOL_INSTRUCTIONS: ReadonlySet<string> = new Set([
  'Buy', 'BuyExactQuoteIn', 'Sell', 'BuyV2', 'BuyExactQuoteInV2', 'SellV2', 'SweepCreatorFee', 'SweepProtocolFee', 'BoostBuyAndBurn',
  'InitBoost', 'CreatePool', 'InitUserVolumeAccumulator', 'CloseUserVolumeAccumulator', 'SyncUserVolumeAccumulator', 'ClaimTokenIncentives',
  'CollectCoinCreatorFee', 'ExtendAccount',
]);

const setU64 = (b: Uint8Array, at: number, v: bigint): void => {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setBigUint64(at, v, true);
};
const setI128 = (b: Uint8Array, at: number, v: bigint): void => {
  const u = v < 0n ? (1n << 128n) + v : v;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  dv.setBigUint64(at, u & ((1n << 64n) - 1n), true);
  dv.setBigUint64(at + 8, u >> 64n, true);
};
const getU64 = (b: Uint8Array, at: number): bigint => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true);

export interface CoinRoles {
  readonly mint: string;
  readonly pool: string;
  readonly migrationSlot: number;
  readonly migrationSig: string;
  /**
   * A coin replayed only for its migration and survival read (run.ts `others`): its accounts are served up to this slot
   * (35 minutes after its migration, past the +30 min mark) and refused after it.
   */
  readonly servedUntilSlot?: number;
}

type Role =
  | { kind: 'pool'; coin: CoinRoles }
  | { kind: 'base-vault' | 'quote-vault'; coin: CoinRoles }
  | { kind: 'mint'; coin: CoinRoles }
  | { kind: 'lp-mint'; coin: CoinRoles }
  | { kind: 'config' };

interface PoolTrack {
  readonly addresses: { readonly address: string; readonly baseVault: string; readonly quoteVault: string; readonly lpMint: string };
  /** Slot of the pool's first ExtendAccount (null: none found yet), once looked up. */
  extendedAt?: number | null;
}

interface PoolState {
  readonly baseVault: bigint;
  readonly quoteVault: bigint;
  readonly virtual: bigint;
  readonly coinCreator: string | null;
  readonly lastEvent: { readonly effective: bigint; readonly supply: bigint | null; readonly sig: string; readonly slot: number; readonly idx: number };
}

/** The last PumpSwap trade event on `pool` in a transaction: its supply after and the coin creator it charged. */
const lastTrade = (signature: string, tx: RpcTx, pool: string): { baseSupply: bigint | null; coinCreator: string | null } | null => {
  let out: { baseSupply: bigint | null; coinCreator: string | null } | null = null;
  for (const e of transactionEvents(recordFromRpc(signature, tx as unknown as RpcTransactionBase64))) {
    const d = (e as { data?: Record<string, unknown> }).data;
    if ((e.name === 'BuyEvent' || e.name === 'SellEvent') && d?.['pool'] === pool) out = { baseSupply: (d['baseSupply'] as bigint | undefined) ?? null, coinCreator: (d['coinCreator'] as string | undefined) ?? null };
  }
  return out;
};

export class AccountWorld {
  readonly #chain: ChainView;
  readonly #net: PublicRpc;
  readonly #roles = new Map<string, Role>();
  readonly #snap = new Map<string, Snapshot>();
  readonly #pools = new Map<string, PoolTrack>();
  holders: HolderBook | null = null;
  readonly stats = new Map<string, number>();

  constructor(chain: ChainView, net: PublicRpc) {
    this.#chain = chain;
    this.#net = net;
    this.#roles.set(PUMP_AMM_GLOBAL_CONFIG, { kind: 'config' });
    this.#roles.set(PUMP_AMM_FEE_CONFIG, { kind: 'config' });
  }

  #count(k: string): void {
    this.stats.set(k, (this.stats.get(k) ?? 0) + 1);
  }

  /** Registers a replayed coin: its pool, vaults and LP mint (fixed at creation, read from today's pool account). */
  async addCoin(c: CoinRoles): Promise<void> {
    const p = await this.snapshot(c.pool);
    if (p.value === null) throw new Error(`pool ${c.pool} has no account today`);
    const d = decodePool(fromBase64(p.value.data[0])).value;
    this.#roles.set(c.mint, { kind: 'mint', coin: c });
    this.#roles.set(c.pool, { kind: 'pool', coin: c });
    this.#roles.set(d.poolBaseTokenAccount, { kind: 'base-vault', coin: c });
    this.#roles.set(d.poolQuoteTokenAccount, { kind: 'quote-vault', coin: c });
    this.#roles.set(d.lpMint, { kind: 'lp-mint', coin: c });
    this.#pools.set(c.pool, { addresses: { address: c.pool, baseVault: d.poolBaseTokenAccount, quoteVault: d.poolQuoteTokenAccount, lpMint: d.lpMint } });
  }

  /** The pool's base vault of a registered mint (the template of its token accounts' extension bytes). */
  baseVaultOf(mint: string): string | null {
    const r = this.#roles.get(mint);
    if (r === undefined || r.kind !== 'mint') return null;
    return this.#pools.get(r.coin.pool)?.addresses.baseVault ?? null;
  }

  roleOf(address: string): string | null {
    return this.#roles.get(address)?.kind ?? null;
  }

  /** Today's account (read once, at finalized, and kept on disk with its slot). */
  async snapshot(address: string): Promise<Snapshot> {
    const hit = this.#snap.get(address);
    if (hit !== undefined) return hit;
    const s = await this.#net.cached<Snapshot>(`acct-${address}`, async () => {
      const r = await this.#net.result<{ context: { slot: number }; value: RawAccount | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
      return { slot: r.context.slot, value: r.value };
    });
    this.#snap.set(address, s);
    return s;
  }

  /** Whether any successful transaction touched `address` in slots (asOf, snapshot slot]. */
  async #touchedAfter(address: string, asOf: number, snapSlot: number): Promise<boolean> {
    // The newest successful signature's slot as of today's snapshot (read once, kept with it); a full page of failures
    // counts as touched (the next page is not read).
    const newest = await this.#net.cached<{ slot: number }>(`newest-ok-${address}-${snapSlot}`, async () => {
      const page = await this.#chain.signatures(address, snapSlot, { limit: 1000 });
      const ok = page.find((x) => x.err === null);
      return { slot: ok !== undefined ? ok.slot : page.length >= 1000 ? Number.MAX_SAFE_INTEGER : -1 };
    });
    return newest.slot > asOf;
  }

  /** `getMultipleAccounts` / `getAccountInfo` as of `asOf`. */
  async read(addresses: readonly string[], asOf: number, cfg: Record<string, unknown> | undefined): Promise<(RawAccount | null)[]> {
    const slice = cfg?.['dataSlice'] as { offset: number; length: number } | undefined;
    const out: (RawAccount | null)[] = [];
    for (const a of addresses) {
      const v = slice !== undefined && slice.length === 0 ? await this.#ownerOnly(a) : await this.account(a, asOf);
      out.push(v === null ? null : slice === undefined ? v : sliceData(v, slice));
    }
    return out;
  }

  /**
   * An owner's program only (`dataSlice` of 0 bytes: the holder reads classify owners by it). Today's owner: a wallet
   * (System-owned) can only stop being one by assigning itself to a program, and a program's account (a PDA) keeps its
   * owner; README "Owner programs" states this approximation.
   */
  async #ownerOnly(address: string): Promise<RawAccount | null> {
    const s = await this.snapshot(address);
    this.#count('owner-only');
    return s.value;
  }

  async account(address: string, asOf: number): Promise<RawAccount | null> {
    const role = this.#roles.get(address);
    const snap = await this.snapshot(address);
    if (role === undefined) {
      // A holder's token account, or nothing we can rebuild.
      if (this.holders !== null) {
        const h = await this.holders.tokenAccount(address, asOf);
        if (h !== undefined) return h;
      }
      if (!(await this.#touchedAfter(address, asOf, snap.slot))) {
        this.#count('unchanged:other');
        return snap.value;
      }
      throw new Refused('account-not-rebuildable', address);
    }
    if (role.kind !== 'config' && role.coin.servedUntilSlot !== undefined && asOf > role.coin.servedUntilSlot) throw new Refused('other-coin-not-replayed', address);
    switch (role.kind) {
      case 'config': {
        // Only the admin writes the configs: none of its successful transactions after asOf touched them, or refuse.
        if (await this.#adminTouched(address, asOf, snap.slot)) throw new Refused('config-changed-after', address);
        this.#count('config');
        return snap.value;
      }
      case 'lp-mint': {
        // LP supply moves only by deposits and withdrawals (minted and burned by the pool): today's supply less the net
        // change of every later LP-mint transaction (from their own meta). Nothing else in the account can change.
        if (snap.value === null) throw new Refused('closed-since', address);
        const delta = await this.#lpDeltaAfter(address, asOf, snap.slot);
        const b = fromBase64(snap.value.data[0]).slice();
        setU64(b, MINT_SUPPLY, getU64(b, MINT_SUPPLY) - delta);
        this.#count('lp-mint');
        return { ...snap.value, data: [toBase64(b), 'base64'] };
      }
      case 'pool':
      case 'base-vault':
      case 'quote-vault': {
        const st = await this.#stateAt(role.coin, asOf);
        if (st === null) return null; // before the migration: the pool does not exist yet
        if (snap.value === null) throw new Refused('closed-since', address);
        const data = fromBase64(snap.value.data[0]);
        if (role.kind === 'pool') {
          const t = this.#pools.get(role.coin.pool)!;
          // Fields only an admin or creator instruction changes are today's when they still equal their migration values;
          // the coin creator is the one the last trade before asOf charged for.
          const today = decodePool(data).value;
          const created = await this.#created(role.coin);
          if (today.isMayhemMode !== created.isMayhemMode || (today.creatorFeeBps ?? 0n) !== (created.creatorFeeBps ?? 0n) || (today.canEditCreatorFee ?? false) !== (created.canEditCreatorFee ?? false) || (today.isHolderReward ?? false) !== (created.isHolderReward ?? false)) {
            throw new Refused('pool-fields-changed', address);
          }
          // LP supply: today's less the LP mint's net change after asOf (deposits and withdrawals move both alike).
          const lpSnap = await this.snapshot(t.addresses.lpMint);
          const lpDelta = await this.#lpDeltaAfter(t.addresses.lpMint, asOf, lpSnap.slot);
          // A pool is created shorter (the migration's createAccount) and grown by ExtendAccount; until the first one
          // the account was the creation length, today's leading bytes.
          const size = (await this.#extendedBy(role.coin, asOf)) ? data.length : await this.#creationSize(role.coin);
          if (size > data.length) throw new Refused('pool-shrunk', address);
          const b = data.slice(0, size);
          setI128(b, POOL_VIRTUAL, st.virtual);
          setU64(b, POOL_LP_SUPPLY, getU64(b, POOL_LP_SUPPLY) - lpDelta);
          if (st.coinCreator !== null) b.set(decodeBase58(st.coinCreator), POOL_COIN_CREATOR);
          this.#count('pool');
          return { ...snap.value, space: size, data: [toBase64(b), 'base64'] };
        }
        const amount = role.kind === 'base-vault' ? st.baseVault : st.quoteVault;
        const b = data.slice();
        setU64(b, TOKEN_AMOUNT, amount);
        let lamports = snap.value.lamports;
        // A wrapped-SOL vault holds its amount plus its rent reserve in lamports.
        if (role.kind === 'quote-vault' && b[TOKEN_IS_NATIVE] === 1) lamports = Number(amount + getU64(b, TOKEN_IS_NATIVE + 4));
        this.#count(role.kind);
        return { ...snap.value, lamports, data: [toBase64(b), 'base64'] };
      }
      case 'mint': {
        if (snap.value === null) throw new Refused('closed-since', address);
        const data = fromBase64(snap.value.data[0]);
        // Authorities revoked today means revoked at asOf (a revoked authority can never be set again).
        const supply = await this.#supplyAt(role.coin, asOf);
        const b = data.slice();
        setU64(b, MINT_SUPPLY, supply);
        this.#count('mint');
        return { ...snap.value, data: [toBase64(b), 'base64'] };
      }
    }
  }

  readonly #sizes = new Map<string, number>();
  /** The pool's length at creation: the space of the migration's System createAccount for it. */
  async #creationSize(c: CoinRoles): Promise<number> {
    const hit = this.#sizes.get(c.pool);
    if (hit !== undefined) return hit;
    const size = await this.#net.cached<number>(`pool-size-${c.pool}`, () => this.#creationSizeRead(c));
    this.#sizes.set(c.pool, size);
    return size;
  }

  async #creationSizeRead(c: CoinRoles): Promise<number> {
    const tx = (await this.#net.tx(c.migrationSig)) as RpcTx | null;
    if (tx === null) throw new Refused('migration-tx-missing', c.migrationSig);
    const rec = recordFromRpc(c.migrationSig, tx as unknown as RpcTransactionBase64);
    const keys = accountKeys(c.migrationSig, tx);
    for (const g of rec.innerInstructions ?? []) {
      for (const ix of g.instructions) {
        const i = ix as unknown as { programIdIndex: number; accounts: number[]; data: Uint8Array };
        if (keys[i.programIdIndex] !== SYSTEM_PROGRAM || keys[i.accounts[1]!] !== c.pool) continue;
        const d = Buffer.from(i.data);
        if (d.readUInt32LE(0) !== 0) continue; // CreateAccount
        return Number(d.readBigUInt64LE(12));
      }
    }
    throw new Refused('pool-creation-size-unknown', c.pool);
  }

  readonly #lpChanged = new Map<string, boolean>();
  /** Slots of the admin's successful transactions that include each config, newest first (read once). */
  readonly #adminTouches = new Map<string, number[]>();

  /** Every successful LP-mint transaction (slot, net LP minted), read once against today's snapshot. */
  async #lpDeltaAfter(lpMint: string, asOf: number, snapSlot: number): Promise<bigint> {
    let list = this.#lpTxs.get(lpMint);
    if (list === undefined) {
      list = await this.#net.cached<{ slot: number; delta: string }[]>(`lp-txs-${lpMint}-${snapSlot}`, async () => {
        const out: { slot: number; delta: string }[] = [];
        const sigs = await this.#chain.signatures(lpMint, snapSlot, { limit: 1000 });
        if (sigs.length >= 1000) throw new Refused('lp-history-long', lpMint);
        for (const x of sigs) {
          if (x.err !== null) continue;
          const tx = (await this.#net.tx(x.signature)) as RpcTx | null;
          if (tx === null) throw new Refused('lp-tx-missing', x.signature);
          out.push({ slot: x.slot, delta: supplyDelta(tx, lpMint).toString() });
        }
        return out;
      });
      this.#lpTxs.set(lpMint, list);
    }
    return list.filter((x) => x.slot > asOf).reduce((s, x) => s + BigInt(x.delta), 0n);
  }

  readonly #lpTxs = new Map<string, { slot: number; delta: string }[]>();

  /**
   * Whether the configs' single admin ran a successful transaction including `address` after `asOf`. Its newest
   * signatures come from the Foundation's archive (publicnode's 20-hour ledger cannot show that nothing happened
   * before it), read once and kept with today's snapshot.
   */
  async #adminTouched(address: string, asOf: number, _snapSlot: number): Promise<boolean> {
    let touches = this.#adminTouches.get(address);
    if (touches === undefined) {
      const archive = this.#net.urls.at(-1)!;
      const page = await this.#net.cached<RawSig[]>(`admin-sigs-${CONFIG_ADMIN}`, async () => {
        const r = await fetch(archive, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [CONFIG_ADMIN, { limit: 1000, commitment: 'finalized' }] }) });
        const b = (await r.json()) as { result?: RawSig[] };
        if (!Array.isArray(b.result)) throw new Error('admin history unreadable');
        return b.result;
      });
      touches = [];
      for (const x of page) {
        if (x.err !== null) continue;
        const tx = (await this.#net.tx(x.signature)) as RpcTx | null;
        if (tx === null || accountKeys(x.signature, tx).includes(address)) touches.push(x.slot);
      }
      this.#adminTouches.set(address, touches);
    }
    return touches.some((s) => s > asOf);
  }


  readonly #stateCache = new Map<string, PoolState | null>();

  /**
   * The pool as of `asOf`, walking its transactions back from there: the vaults from the newest one that moved them, E
   * from the newest one with a pool event (trades, boost, creation; event-less ones such as sweeps keep E), virtual =
   * E − quote vault (pool-state.ts, validated against every next trade's pre-trade fields). Null before the migration.
   */
  async #stateAt(c: CoinRoles, asOf: number): Promise<PoolState | null> {
    if (asOf < c.migrationSlot) return null;
    const key = `${c.pool}:${asOf}`;
    if (this.#stateCache.has(key)) return this.#stateCache.get(key)!;
    const t = this.#pools.get(c.pool)!;
    let vaults: { slot: number; baseVault: bigint; quoteVault: bigint } | null = null;
    let found: { effective: bigint; supply: bigint | null; coinCreator: string | null; sig: string; slot: number; idx: number } | null = null;
    let walked = 0;
    for await (const x of this.#chain.newestFirst(c.pool, asOf)) {
      if (x.err !== null) continue;
      if (++walked > 2_000) break;
      const tx = (await this.#net.tx(x.signature)) as RpcTx | null;
      if (tx === null) throw new Refused('pool-tx-missing', x.signature);
      const a = poolAfter(x.signature, tx, t.addresses, null);
      if (a === null) continue;
      vaults ??= { slot: x.slot, baseVault: a.baseVault, quoteVault: a.quoteVault };
      if (a.effective !== null) {
        const ev = lastTrade(x.signature, tx, c.pool);
        found = { effective: a.effective, supply: ev?.baseSupply ?? null, coinCreator: ev?.coinCreator ?? null, sig: x.signature, slot: x.slot, idx: x.transactionIndex ?? -1 };
        break;
      }
    }
    if (vaults === null || found === null) throw new Refused('pool-state-not-found', c.pool);
    const st: PoolState = { baseVault: vaults.baseVault, quoteVault: vaults.quoteVault, virtual: found.effective - vaults.quoteVault, lastEvent: found, coinCreator: found.coinCreator };
    this.#stateCache.set(key, st);
    return st;
  }

  readonly #createdCache = new Map<string, { isMayhemMode: boolean; creatorFeeBps: bigint | null; canEditCreatorFee: boolean | null; isHolderReward: boolean | null }>();
  /** The pool's fields as created (the migration's CreatePoolEvent). */
  async #created(c: CoinRoles): Promise<{ isMayhemMode: boolean; creatorFeeBps: bigint | null; canEditCreatorFee: boolean | null; isHolderReward: boolean | null }> {
    const hit = this.#createdCache.get(c.pool);
    if (hit !== undefined) return hit;
    const tx = (await this.#net.tx(c.migrationSig)) as RpcTx | null;
    if (tx === null) throw new Refused('migration-tx-missing', c.migrationSig);
    const e = transactionEvents(recordFromRpc(c.migrationSig, tx as unknown as RpcTransactionBase64)).find((x) => x.name === 'CreatePoolEvent' && ((x as { data?: Record<string, unknown> }).data)?.['pool'] === c.pool);
    if (e === undefined) throw new Refused('no-create-pool-event', c.migrationSig);
    const d = (e as unknown as { data: Record<string, unknown> }).data;
    const v = { isMayhemMode: d['isMayhemMode'] === true, creatorFeeBps: (d['creatorFeeBps'] as bigint | undefined) ?? null, canEditCreatorFee: (d['canEditCreatorFee'] as boolean | undefined) ?? null, isHolderReward: (d['isHolderReward'] as boolean | undefined) ?? null };
    this.#createdCache.set(c.pool, v);
    return v;
  }

  /** Whether an ExtendAccount on the pool ran at or before `asOf` (its own instruction data, not its logs). */
  async #extendedBy(c: CoinRoles, asOf: number): Promise<boolean> {
    const t = this.#pools.get(c.pool)!;
    if (t.extendedAt === undefined) {
      const known = await this.#net.cached<{ slot: number | null }>(`pool-extend-${c.pool}`, async () => ({ slot: await this.#firstExtend(c) }));
      t.extendedAt = known.slot;
    }
    return t.extendedAt !== null && t.extendedAt <= asOf;
  }

  /** The slot of the pool's first ExtendAccount (its own instruction data), searched forward from the migration. */
  async #firstExtend(c: CoinRoles): Promise<number | null> {
    // The first extend comes seconds after the migration (measured); scanned forward over the first 40 buckets.
    for (let from = c.migrationSlot - 1, n = 0; n < 40; n++, from += 750) {
      const sigs = (await this.#chain.signaturesBetween(c.pool, from, from + 750)).filter((x) => x.err === null);
      for (const x of orderSigs(sigs)) {
        const tx = (await this.#net.tx(x.signature)) as RpcTx | null;
        if (tx === null) continue;
        if (ammInstructions(x.signature, tx).includes('ExtendAccount')) return x.slot;
      }
    }
    throw new Refused('pool-extend-not-found', c.pool);
  }

  /**
   * The mint's supply at `asOf`: the last pool trade's `baseSupply` (the supply after its transaction: 113,561 of
   * 113,561 trades on 16 non-mayhem coins, validate-supply.ts) plus the token balance change of every later mint
   * transaction up to asOf (only burns move it). Mayhem pools are refused (their agent's supply is not in the field).
   */
  async #supplyAt(c: CoinRoles, asOf: number): Promise<bigint> {
    // Mayhem pools: the field leaves out the agent's supply, so the sum of every mint transaction from the create.
    if ((await this.#created(c)).isMayhemMode) {
      // For a coin replayed only to its survival read the full mint history is not collected: refused.
      if (c.servedUntilSlot !== undefined) throw new Refused('mayhem-supply-not-collected', c.mint);
      return this.#supplyFromCreate(c, asOf);
    }
    const st = await this.#stateAt(c, asOf);
    if (st === null) throw new Refused('mint-before-migration', c.mint);
    if (st.lastEvent.supply === null) throw new Refused('no-trade-before', c.mint);
    let supply = st.lastEvent.supply;
    // Later mint transactions up to asOf (newest first back to the trade's transaction).
    let n = 0;
    for await (const x of this.#chain.newestFirst(c.mint, asOf)) {
      if (x.signature === st.lastEvent.sig) return supply;
      if (x.slot < st.lastEvent.slot) throw new Refused('mint-trade-not-listed', c.mint);
      if (++n > 2_000) break;
      if (x.err !== null) continue;
      const tx = (await this.#net.tx(x.signature)) as RpcTx | null;
      if (tx === null) throw new Refused('mint-tx-missing', x.signature);
      supply += supplyDelta(tx, c.mint);
    }
    throw new Refused('mint-history-long', c.mint);
  }

  /** The supply as the sum of every successful mint transaction's token balance change from the create to asOf. */
  async #supplyFromCreate(c: CoinRoles, asOf: number): Promise<bigint> {
    const sigs = orderSigs((await this.#chain.signaturesBetween(c.mint, 0, asOf)).filter((x) => x.err === null));
    if (sigs.length > 60_000) throw new Refused('mint-history-long', c.mint);
    let supply = 0n;
    for (const [i, x] of sigs.entries()) {
      const tx = (await this.#net.tx(x.signature)) as RpcTx | null;
      if (tx === null) throw new Refused('mint-tx-missing', x.signature);
      if (i === 0 && !(tx.meta.logMessages ?? []).some((l) => /Instruction: Create(V2)?$/.test(l))) throw new Refused('mint-history-not-from-create', c.mint);
      supply += supplyDelta(tx, c.mint);
    }
    return supply;
  }

  async largest(mint: string, asOf: number): Promise<unknown> {
    if (this.holders === null) throw new Refused('holders-not-rebuilt', mint);
    return this.holders.largest(mint, asOf);
  }

  async programAccounts(program: string, cfg: Record<string, unknown> | undefined, asOf: number): Promise<unknown> {
    if (this.holders === null) throw new Refused('holders-not-rebuilt', program);
    return this.holders.programAccounts(program, cfg, asOf);
  }
}

const sliceData = (v: RawAccount, s: { offset: number; length: number }): RawAccount => {
  const d = fromBase64(v.data[0]);
  return { ...v, data: [toBase64(d.slice(s.offset, s.offset + s.length)), 'base64'] };
};

/** Block order: slot, then position in the block (reverse page order where the node gave none). */
export const orderSigs = (sigs: readonly RawSig[]): RawSig[] => {
  const pos = new Map(sigs.map((s, i) => [s.signature, i] as const));
  return [...sigs].sort((a, b) => a.slot - b.slot || (a.transactionIndex ?? -1) - (b.transactionIndex ?? -1) || pos.get(b.signature)! - pos.get(a.signature)!);
};

/** Net mint/burn of a transaction for `mint`: the sum of (post − pre) over its token balances of that mint. */
export const supplyDelta = (tx: RpcTx, mint: string): bigint => {
  const sum = (bs: RpcTx['meta']['preTokenBalances']) => (bs ?? []).filter((b) => b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
};

const isCreate = (tx: RpcTx): boolean => (tx.meta.logMessages ?? []).some((l) => l === 'Program log: Instruction: Create' || l === 'Program log: Instruction: CreateV2');

const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
/** Anchor discriminators of PumpSwap's instructions: sha256("global:<snake name>")[0..8], by the name its logs print. */
const AMM_NAMES = [
  'buy', 'sell', 'buy_exact_quote_in', 'buy_v2', 'sell_v2', 'buy_exact_quote_in_v2', 'sweep_creator_fee', 'sweep_protocol_fee', 'boost_buy_and_burn',
  'init_boost', 'create_pool', 'init_user_volume_accumulator', 'close_user_volume_accumulator', 'sync_user_volume_accumulator', 'claim_token_incentives',
  'collect_coin_creator_fee', 'extend_account', 'deposit', 'withdraw', 'set_coin_creator', 'admin_set_coin_creator', 'update_fee_config', 'update_admin',
  'create_config', 'disable', 'set_reserved_fee_recipients', 'toggle_mayhem_mode', 'set_creator_fee_bps', 'transfer_creator_fees_to_pump',
];
const camel = (snake: string): string => snake.split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
const AMM_DISC = new Map(AMM_NAMES.map((n) => [createHash('sha256').update(`global:${n}`).digest('hex').slice(0, 16), camel(n)] as const));

/**
 * PumpSwap instructions a transaction ran, top level and inner (from its own instruction data, so a truncated log
 * cannot hide one), named as its logs name them; an unlisted discriminator is `unknown:<hex>`. Self-CPI event
 * records (Anchor's `emit_cpi`, discriminator e445a52e51cb9a1d) are not instructions and are skipped.
 */
export const ammInstructions = (signature: string, tx: RpcTx): string[] => {
  const rec = recordFromRpc(signature, tx as unknown as RpcTransactionBase64);
  const keys = accountKeys(signature, tx);
  const decoded = decodeTransaction(rec.transaction);
  const all: { programIdIndex: number; data: Uint8Array }[] = [...decoded.instructions as unknown as { programIdIndex: number; data: Uint8Array }[]];
  for (const g of rec.innerInstructions ?? []) all.push(...(g.instructions as unknown as { programIdIndex: number; data: Uint8Array }[]));
  const out: string[] = [];
  for (const ix of all) {
    if (keys[ix.programIdIndex] !== AMM) continue;
    const hex = Buffer.from(ix.data.slice(0, 8)).toString('hex');
    if (hex === 'e445a52e51cb9a1d') continue;
    out.push(AMM_DISC.get(hex) ?? `unknown:${hex}`);
  }
  return out;
};

void NATIVE_MINT;
void SYSTEM_PROGRAM;
void TOKEN_PROGRAM;
void TOKEN_2022_PROGRAM;
export type { Address };
