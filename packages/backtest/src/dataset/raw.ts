// Raw transaction records (DATA-1 schema 2, raw-NNN.jsonl.zst) reduced at load time to what the gates read:
// - token balances before and after the transaction, for the sampled mints it touches (H12 holders);
// - the token-program instructions that set a mint's authorities and extensions or change a supply (H1–H4, H6).
// The full record (wire bytes, logs) is dropped after this step, so a day of raw records fits in memory.
// Everything here is a fact of that transaction, known at its slot (docs/research/historical-data.md "Point in time").
import {
  type Address, accountKeys, decodeTransaction, encodeBase58, fromBase64, TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
} from '../../../core/src/chain/index.ts';
import type { ChainPos } from './rows.ts';

/** A raw record sorts after every event of its own transaction. */
export const RAW_EV_IDX = 1_000_000;

export interface RawBalance {
  readonly account: string;
  readonly mint: string;
  /** Owner of the token account; null when the record did not carry it. */
  readonly owner: string | null;
  /** Null: the account did not exist on that side of the transaction. */
  readonly pre: bigint | null;
  readonly post: bigint | null;
}

/** Token-2022 extension set up on a mint, by the instruction that initialised it. */
export interface ExtensionInit {
  /** DEC-1's extension name, or 'unknown' with the instruction tag as `type`. */
  readonly kind: string;
  readonly type: number;
  /** DefaultAccountState only: the state it sets. */
  readonly state?: 'uninitialized' | 'initialized' | 'frozen';
}

export type TokenOp =
  | { readonly op: 'init-mint'; readonly program: string; readonly mint: string; readonly mintAuthority: string | null; readonly freezeAuthority: string | null }
  | { readonly op: 'set-authority'; readonly program: string; readonly account: string; readonly authorityType: number; readonly newAuthority: string | null }
  | { readonly op: 'mint-to'; readonly program: string; readonly mint: string; readonly amount: bigint }
  | { readonly op: 'burn'; readonly program: string; readonly mint: string; readonly amount: bigint }
  | { readonly op: 'extension'; readonly program: string; readonly mint: string; readonly ext: ExtensionInit }
  /** Approve / ApproveChecked on a token account; Revoke and CloseAccount clear it (GATE-1e delegates). */
  | { readonly op: 'approve'; readonly program: string; readonly account: string; readonly delegate: string; readonly amount: bigint }
  | { readonly op: 'revoke'; readonly program: string; readonly account: string };

export interface RawRow extends ChainPos {
  readonly kind: 'raw';
  /** Sampled mints the record references (the scanner's `mints`). */
  readonly mints: readonly string[];
  readonly balances: readonly RawBalance[];
  /** Token-program instructions in execution order (top-level, then its inner list). */
  readonly ops: readonly TokenOp[];
  /** Set when the record could not be decoded: the mints it touches lose their raw-derived facts. */
  readonly undecodable: string | null;
}

interface RawJson {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly txIndex: number;
  readonly signature: string;
  readonly transaction: string;
  readonly err: unknown;
  readonly mints?: readonly string[] | null;
  readonly meta: {
    readonly loadedAddresses?: { readonly writable?: readonly string[] | null; readonly readonly?: readonly string[] | null } | null;
    readonly innerInstructions?: readonly { readonly index: number; readonly instructions: readonly { readonly programIdIndex: number; readonly accounts: readonly number[]; readonly data: string }[] }[] | null;
    readonly preTokenBalances?: readonly TokenBalanceJson[] | null;
    readonly postTokenBalances?: readonly TokenBalanceJson[] | null;
  };
}

interface TokenBalanceJson {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string };
}

const u64 = (d: Uint8Array, at: number): bigint | null => {
  if (d.length < at + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]!);
  return v;
};
const key = (d: Uint8Array, at: number): string | null => (d.length < at + 32 ? null : encodeBase58(d.subarray(at, at + 32)));
/** COption<Pubkey> in instruction data: one tag byte, then 32 bytes when set. */
const optKey = (d: Uint8Array, at: number): { value: string | null } | null => {
  if (d.length < at + 1) return null;
  if (d[at] === 0) return { value: null };
  const k = key(d, at + 1);
  return k === null ? null : { value: k };
};

/** Token-2022 extension-initialise instruction tags (spl-token-2022 `TokenInstruction`), each with the extension it sets. */
const EXT_BY_TAG: Readonly<Record<number, string>> = {
  25: 'MintCloseAuthority', 26: 'TransferFeeConfig', 27: 'ConfidentialTransferMint', 28: 'DefaultAccountState',
  32: 'NonTransferable', 33: 'InterestBearingConfig', 35: 'PermanentDelegate', 36: 'TransferHook',
  37: 'ConfidentialTransferFeeConfig', 39: 'MetadataPointer', 40: 'GroupPointer', 41: 'GroupMemberPointer',
  42: 'ConfidentialMintBurn', 43: 'ScaledUiAmount', 44: 'Pausable',
};
/** spl-token-metadata-interface `initialize` discriminator (sha256("spl_token_metadata_interface:initialize_account")[..8]). */
const TOKEN_METADATA_INIT = [210, 225, 30, 162, 88, 184, 77, 141];
/** spl-token-group-interface `initialize_group` and `initialize_member`. */
const TOKEN_GROUP_INIT = [121, 113, 108, 39, 54, 51, 0, 4];
const TOKEN_MEMBER_INIT = [152, 32, 222, 176, 223, 237, 116, 134];
const startsWith = (d: Uint8Array, p: readonly number[]) => d.length >= p.length && p.every((b, i) => d[i] === b);

/**
 * One token-program instruction as a TokenOp, or null when it changes nothing the gates read (transfers, account
 * set-up). Unknown Token-2022 tags that name a mint as their first account are not guessed: `tokenOps`
 * reports them as unknown extensions when they come before that mint's initialisation.
 */
const tokenOp = (program: string, d: Uint8Array, acct: (i: number) => string | undefined): TokenOp | 'unknown-tag' | null => {
  if (d.length === 0) return null;
  const tag = d[0]!;
  if (program === TOKEN_2022_PROGRAM && startsWith(d, TOKEN_METADATA_INIT)) {
    const mint = acct(2);
    return mint === undefined ? null : { op: 'extension', program, mint, ext: { kind: 'TokenMetadata', type: 19 } };
  }
  if (program === TOKEN_2022_PROGRAM && (startsWith(d, TOKEN_GROUP_INIT) || startsWith(d, TOKEN_MEMBER_INIT))) {
    const mint = acct(1);
    const kind = startsWith(d, TOKEN_GROUP_INIT) ? 'TokenGroup' : 'TokenGroupMember';
    return mint === undefined ? null : { op: 'extension', program, mint, ext: { kind, type: kind === 'TokenGroup' ? 21 : 23 } };
  }
  switch (tag) {
    case 0:
    case 20: {
      // InitializeMint: decimals, mint authority, COption freeze authority. InitializeMint2 has the same data.
      const mint = acct(0);
      const auth = key(d, 2);
      const freeze = optKey(d, 34);
      if (mint === undefined || auth === null || freeze === null) return 'unknown-tag';
      return { op: 'init-mint', program, mint, mintAuthority: auth, freezeAuthority: freeze.value };
    }
    case 6: {
      const account = acct(0);
      const next = optKey(d, 2);
      if (account === undefined || d.length < 2 || next === null) return 'unknown-tag';
      return { op: 'set-authority', program, account, authorityType: d[1]!, newAuthority: next.value };
    }
    case 4:
    case 13: {
      // Approve: [source, delegate, owner]; ApproveChecked: [source, mint, delegate, owner]. Data: tag, u64 amount.
      const account = acct(0);
      const delegate = acct(tag === 4 ? 1 : 2);
      const amount = u64(d, 1);
      return account === undefined || delegate === undefined || amount === null ? null : { op: 'approve', program, account, delegate, amount };
    }
    case 5:
    case 9: {
      // Revoke: [source, owner]; CloseAccount: [account, destination, owner]. Either leaves the account with no delegate.
      const account = acct(0);
      return account === undefined ? null : { op: 'revoke', program, account };
    }
    case 7:
    case 14: {
      const mint = acct(0);
      const amount = u64(d, 1);
      return mint === undefined || amount === null ? 'unknown-tag' : { op: 'mint-to', program, mint, amount };
    }
    case 8:
    case 15: {
      const mint = acct(1);
      const amount = u64(d, 1);
      return mint === undefined || amount === null ? 'unknown-tag' : { op: 'burn', program, mint, amount };
    }
    default: {
      if (program !== TOKEN_2022_PROGRAM) return null;
      const kind = EXT_BY_TAG[tag];
      if (kind === undefined) return 'unknown-tag';
      const mint = acct(0);
      if (mint === undefined) return null;
      // Every extension-initialise instruction's first sub-tag 0 is "initialise"; later sub-tags update or toggle.
      if (d[1] !== undefined && d[1] !== 0 && ![25, 32, 35].includes(tag)) return null;
      const ext: ExtensionInit = kind === 'DefaultAccountState'
        ? { kind, type: 6, state: d[2] === 1 ? 'initialized' : d[2] === 2 ? 'frozen' : 'uninitialized' }
        : { kind, type: EXTENSION_TYPE[kind] ?? -1 };
      return { op: 'extension', program, mint, ext };
    }
  }
};

/** DEC-1's extension type numbers for the kinds above (ExtensionType in spl-token-2022). */
const EXTENSION_TYPE: Readonly<Record<string, number>> = {
  TransferFeeConfig: 1, MintCloseAuthority: 3, ConfidentialTransferMint: 4, DefaultAccountState: 6, NonTransferable: 9,
  InterestBearingConfig: 10, PermanentDelegate: 12, TransferHook: 14, ConfidentialTransferFeeConfig: 16, MetadataPointer: 18,
  TokenMetadata: 19, GroupPointer: 20, TokenGroup: 21, GroupMemberPointer: 22, TokenGroupMember: 23, ConfidentialMintBurn: 24,
  ScaledUiAmount: 25, Pausable: 26,
};

/**
 * Token ops of a decoded transaction. An unknown Token-2022 tag whose first account is a mint the transaction
 * initialises (an InitializeMint later in the same transaction) is reported as an unknown extension of that mint,
 * so H4 rejects it rather than missing it.
 */
const tokenOps = (keys: readonly Address[], ixs: readonly { programIdIndex: number; accounts: readonly number[]; data: Uint8Array }[]): TokenOp[] => {
  const out: TokenOp[] = [];
  const pendingUnknown: { mint: string; tag: number; program: string }[] = [];
  for (const ix of ixs) {
    const program = keys[ix.programIdIndex];
    if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) continue;
    const acct = (i: number): string | undefined => {
      const k = ix.accounts[i];
      return k === undefined ? undefined : keys[k];
    };
    const op = tokenOp(program, ix.data, acct);
    if (op === 'unknown-tag') {
      const first = acct(0);
      if (program === TOKEN_2022_PROGRAM && first !== undefined && ix.data.length > 0) pendingUnknown.push({ mint: first, tag: ix.data[0]!, program });
      continue;
    }
    if (op === null) continue;
    if (op.op === 'init-mint') {
      for (const u of pendingUnknown.filter((p) => p.mint === op.mint)) out.push({ op: 'extension', program: u.program, mint: u.mint, ext: { kind: 'unknown', type: u.tag } });
    }
    out.push(op);
  }
  return out;
};

const big = (s: string | undefined): bigint | null => (s !== undefined && /^\d+$/.test(s) ? BigInt(s) : null);

/** One raw-NNN.jsonl line as a RawRow, or null for a failed transaction (it changed no balance the gates read). */
export const compactRaw = (line: string): RawRow | null => {
  const o = JSON.parse(line) as RawJson;
  if (o.err !== null && o.err !== undefined) return null;
  const mints = [...(o.mints ?? [])];
  const pos = { slot: BigInt(o.slot), blockTime: o.blockTime ?? 0, txIdx: o.txIndex, evIdx: RAW_EV_IDX, signature: o.signature };
  const base = { kind: 'raw' as const, ...pos, mints };
  try {
    const tx = decodeTransaction(fromBase64(o.transaction));
    const keys = accountKeys(tx, {
      writable: (o.meta.loadedAddresses?.writable ?? []) as Address[],
      readonly: (o.meta.loadedAddresses?.readonly ?? []) as Address[],
    });
    const wanted = new Set(mints);
    const bal = new Map<string, { account: string; mint: string; owner: string | null; pre: bigint | null; post: bigint | null }>();
    const take = (list: readonly TokenBalanceJson[] | null | undefined, side: 'pre' | 'post') => {
      for (const b of list ?? []) {
        if (!wanted.has(b.mint)) continue;
        const account = keys[b.accountIndex];
        if (account === undefined) throw new RangeError(`token balance index ${b.accountIndex} is out of range`);
        const amount = big(b.uiTokenAmount?.amount);
        if (amount === null) throw new RangeError(`token balance amount "${b.uiTokenAmount?.amount}" is not an integer`);
        const k = `${account}|${b.mint}`;
        const e = bal.get(k) ?? { account, mint: b.mint, owner: null, pre: null, post: null };
        e[side] = amount;
        if (b.owner) e.owner = b.owner;
        bal.set(k, e);
      }
    };
    take(o.meta.preTokenBalances, 'pre');
    take(o.meta.postTokenBalances, 'post');
    // Execution order: each top-level instruction, then the inner instructions it invoked.
    const inner = new Map<number, { programIdIndex: number; accounts: readonly number[]; data: Uint8Array }[]>();
    for (const g of o.meta.innerInstructions ?? []) {
      inner.set(g.index, g.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: fromBase64(ix.data) })));
    }
    const ordered = tx.instructions.flatMap((ix, i) => [{ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: ix.data }, ...(inner.get(i) ?? [])]);
    const balances = [...bal.values()].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : a.mint < b.mint ? -1 : 1));
    const innerMissing = o.meta.innerInstructions === null || o.meta.innerInstructions === undefined;
    return { ...base, balances, ops: tokenOps(keys, ordered), undecodable: innerMissing ? 'inner instructions not recorded' : null };
  } catch (e) {
    return { ...base, balances: [], ops: [], undecodable: e instanceof Error ? e.message : String(e) };
  }
};

export const readRaw = (text: string, out: { push(r: RawRow): void }): void => {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const r = compactRaw(line);
    if (r !== null) out.push(r);
  }
};
