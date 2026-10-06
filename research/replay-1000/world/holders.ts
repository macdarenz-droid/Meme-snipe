// REPLAY-1000: a mint's token accounts as of a past slot, exact or refused.
// - Balances: every successful transaction of the mint up to the slot, replayed in block order; each transaction's own
//   meta states the post balance (and owner) of every token account of the mint it touched. A transfer between two
//   accounts that does not name the mint is not in the mint's history, so every account the replay leaves with tokens
//   (and every account whose pre balance disagrees with the replay) has its own history read up to the slot, and any
//   transaction missing from the set is added; the replay is repeated until nothing is missing.
// - Proof: the balances must sum exactly to the mint's supply at the slot (accounts.ts), else the read is refused.
// - Account bytes: today's account with the balance and owner of the slot; a closed one is rebuilt from the base
//   layout (and, for Token-2022, the extension bytes of the pool's vault of the same mint: AccountType and
//   ImmutableOwner, which every associated token account carries). An account with a delegate today is refused (when
//   the delegate was set is not rebuilt).
import { TOKEN_2022_PROGRAM, decodeBase58, decodeTokenAccount, fromBase64, toBase64, type Address } from '../../../packages/core/src/chain/index.ts';
import type { PublicRpc } from '../rpc.ts';
import { type AccountWorld, type RawAccount, orderSigs } from './accounts.ts';
import type { ChainView } from './chain.ts';
import { accountKeys, type RpcTx } from './pool-state.ts';
import { Refused } from './rpc-world.ts';

interface Holding {
  amount: bigint;
  owner: string;
  program: string;
}

interface Book {
  readonly asOf: number;
  readonly mint: string;
  readonly decimals: number;
  readonly holdings: ReadonlyMap<string, Holding>;
}

/** The most transactions one rebuild may replay, and the most repeat rounds. */
export const HOLDER_TX_CAP = 60_000;
const ROUNDS = 6;

export class HolderBook {
  readonly #chain: ChainView;
  readonly #net: PublicRpc;
  readonly #accounts: AccountWorld;
  readonly #mints: ReadonlySet<string>;
  readonly #books = new Map<string, Book>();
  /** Token account → its mint, for every account any rebuild listed. */
  readonly #mintOf = new Map<string, string>();
  readonly stats = new Map<string, number>();

  constructor(chain: ChainView, net: PublicRpc, accounts: AccountWorld, mints: ReadonlySet<string>) {
    this.#chain = chain;
    this.#net = net;
    this.#accounts = accounts;
    this.#mints = mints;
  }

  #count(k: string, n = 1): void {
    this.stats.set(k, (this.stats.get(k) ?? 0) + n);
  }

  async #book(mint: string, asOf: number): Promise<Book> {
    const key = `${mint}:${asOf}`;
    const hit = this.#books.get(key);
    if (hit !== undefined) return hit;
    if (!this.#mints.has(mint)) throw new Refused('holders-unknown-mint', mint);
    const set = new Map<string, { slot: number; transactionIndex?: number; signature: string; err: unknown; blockTime: number | null }>();
    let n = 0;
    for await (const x of this.#chain.newestFirst(mint, asOf)) {
      if (x.err !== null) continue;
      set.set(x.signature, x);
      if (++n > HOLDER_TX_CAP) throw new Refused('holders-history-long', mint);
    }
    const checked = new Set<string>();
    let holdings = new Map<string, Holding>();
    let decimals = -1;
    for (let round = 0; ; round++) {
      if (round >= ROUNDS) throw new Refused('holders-not-converged', mint);
      holdings = new Map();
      const doubt = new Set<string>();
      let first = true;
      for (const x of orderSigs([...set.values()])) {
        const tx = (await this.#net.tx(x.signature)) as RpcTx | null;
        if (tx === null) throw new Refused('holders-tx-missing', x.signature);
        if (first && !(tx.meta.logMessages ?? []).some((l) => /Instruction: Create(V2)?$/.test(l))) throw new Refused('holders-history-not-from-create', mint);
        first = false;
        const keys = accountKeys(x.signature, tx);
        const post = new Map<string, Holding>();
        for (const b of tx.meta.postTokenBalances ?? []) {
          if (b.mint !== mint) continue;
          decimals = b.uiTokenAmount.decimals;
          post.set(keys[b.accountIndex]!, { amount: BigInt(b.uiTokenAmount.amount), owner: b.owner ?? '', program: b.programId ?? '' });
        }
        for (const b of tx.meta.preTokenBalances ?? []) {
          if (b.mint !== mint) continue;
          const a = keys[b.accountIndex]!;
          const known = holdings.get(a);
          const pre = BigInt(b.uiTokenAmount.amount);
          if ((known?.amount ?? 0n) !== pre) doubt.add(a);
          if (!post.has(a)) holdings.delete(a); // closed in this transaction
        }
        for (const [a, h] of post) holdings.set(a, h);
      }
      // Every account left holding tokens, and every one whose pre balance disagreed: its own history up to asOf.
      const toCheck = [...new Set([...doubt, ...[...holdings].filter(([, h]) => h.amount > 0n).map(([a]) => a)])].filter((a) => !checked.has(a) || doubt.has(a));
      let added = 0;
      for (const a of toCheck) {
        checked.add(a);
        let m = 0;
        for await (const x of this.#chain.newestFirst(a, asOf)) {
          if (++m > 5_000) throw new Refused('holders-account-history-long', a);
          if (x.err !== null || set.has(x.signature)) continue;
          set.set(x.signature, x);
          added++;
        }
      }
      this.#count('holder-history-reads', toCheck.length);
      if (set.size > HOLDER_TX_CAP) throw new Refused('holders-history-long', mint);
      if (added === 0) {
        if (doubt.size > 0) throw new Refused('holders-inconsistent', `${mint}: ${[...doubt][0]}`);
        break;
      }
      this.#count('holder-rounds');
    }
    // Proof: the balances sum to the supply at asOf.
    const m = await this.#accounts.account(mint, asOf);
    if (m === null) throw new Refused('holders-no-mint', mint);
    const supply = new DataView(fromBase64(m.data[0]).buffer).getBigUint64(36, true);
    const sum = [...holdings.values()].reduce((s, h) => s + h.amount, 0n);
    if (sum !== supply) throw new Refused('holders-sum-not-supply', `${mint}: ${sum} vs ${supply}`);
    const book: Book = { asOf, mint, decimals, holdings };
    for (const a of holdings.keys()) this.#mintOf.set(a, mint);
    this.#books.set(key, book);
    this.#count('holder-books');
    return book;
  }

  /** `getTokenLargestAccounts` as of `asOf`: the 20 largest balances (ties by address). */
  async largest(mint: string, asOf: number): Promise<unknown> {
    const b = await this.#book(mint, asOf);
    const top = [...b.holdings].filter(([, h]) => h.amount > 0n).sort((x, y) => (x[1].amount === y[1].amount ? (x[0] < y[0] ? -1 : 1) : x[1].amount > y[1].amount ? -1 : 1)).slice(0, 20);
    return top.map(([address, h]) => ({ address, amount: h.amount.toString(), decimals: b.decimals, uiAmount: Number(h.amount) / 10 ** b.decimals, uiAmountString: uiString(h.amount, b.decimals) }));
  }

  /** `getProgramAccounts` (the mint's token accounts) as of `asOf`, every open account, any balance. */
  async programAccounts(program: string, cfg: unknown, asOf: number): Promise<unknown> {
    const filters = ((cfg as { filters?: unknown[] } | undefined)?.filters ?? []) as { memcmp?: { offset: number; bytes: string }; dataSize?: number }[];
    const mint = filters.find((f) => f.memcmp?.offset === 0)?.memcmp?.bytes;
    if (mint === undefined) throw new Refused('gpa-filter-not-served', JSON.stringify(filters));
    const b = await this.#book(mint, asOf);
    const out: { pubkey: string; account: RawAccount }[] = [];
    for (const [address, h] of b.holdings) {
      if (h.program !== program) continue;
      const acct = await this.#bytes(address, h, b);
      if (filters.some((f) => f.dataSize !== undefined && f.dataSize !== acct.space)) continue;
      out.push({ pubkey: address, account: acct });
    }
    return out;
  }

  /** A token account of a rebuilt mint as of `asOf` (undefined when no rebuild lists it). */
  async tokenAccount(address: string, asOf: number): Promise<RawAccount | null | undefined> {
    const mint = this.#mintOf.get(address);
    if (mint === undefined) return undefined;
    const b = await this.#book(mint, asOf);
    const h = b.holdings.get(address);
    if (h === undefined) return null; // not open at asOf
    return this.#bytes(address, h, b);
  }

  async #bytes(address: string, h: Holding, b: Book): Promise<RawAccount> {
    const snap = await this.#accounts.snapshot(address);
    let data: Uint8Array;
    let base: RawAccount;
    if (snap.value !== null && (snap.value.owner === h.program)) {
      data = fromBase64(snap.value.data[0]).slice();
      base = snap.value;
      const t = decodeTokenAccount(data, snap.value.owner as Address);
      if (t.mint !== b.mint) throw new Refused('holder-account-other-mint', address);
      if (t.delegate !== null) throw new Refused('holder-delegate-today', address);
    } else {
      // Closed since: the base layout, plus the vault's extension bytes for Token-2022.
      data = new Uint8Array(165);
      if (h.program === TOKEN_2022_PROGRAM) {
        const ext = await this.#extensionTemplate(b.mint);
        const d = new Uint8Array(165 + ext.length);
        d.set(ext, 165);
        data = d;
      }
      data.set(decodeBase58(b.mint), 0);
      data[108] = 1; // AccountState::Initialized
      base = { data: ['', 'base64'], executable: false, lamports: 0, owner: h.program, rentEpoch: 0, space: data.length };
      this.#count('holder-rebuilt-closed');
    }
    data.set(decodeBase58(h.owner), 32);
    new DataView(data.buffer).setBigUint64(64, h.amount, true);
    return { ...base, space: data.length, data: [toBase64(data), 'base64'] };
  }

  readonly #ext = new Map<string, Uint8Array>();
  async #extensionTemplate(mint: string): Promise<Uint8Array> {
    const hit = this.#ext.get(mint);
    if (hit !== undefined) return hit;
    const vault = this.#accounts.baseVaultOf(mint);
    const s = vault === null ? null : await this.#accounts.snapshot(vault);
    if (s?.value === null || s === null) throw new Refused('holder-no-extension-template', mint);
    const ext = fromBase64(s.value.data[0]).slice(165);
    this.#ext.set(mint, ext);
    return ext;
  }
}

const uiString = (amount: bigint, decimals: number): string => {
  if (decimals === 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac === '' ? int : `${int}.${frac}`;
};
