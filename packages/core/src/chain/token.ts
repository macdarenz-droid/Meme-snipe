// SPL Token and Token-2022 mints and token accounts, with every Token-2022 extension type (0..28 at
// solana-program/token-2022 bb4c841, interface/src/extension/mod.rs). An extension type this file does not know
// decodes as kind 'unknown' with its raw bytes; nothing in the TLV area is ever skipped.
import type { Address } from './bytes.ts';
import { DecodeError, Reader, toHex } from './bytes.ts';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './programs.ts';

const MINT_SIZE = 82;
const ACCOUNT_SIZE = 165;
const MULTISIG_SIZE = 355;
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;

const ZERO_KEY = '11111111111111111111111111111111';

/** `COption<Pubkey>`: u32 tag (0 or 1) then 32 bytes, always 36 bytes. */
const cOptionPubkey = (r: Reader): Address | null => {
  const tag = r.u32();
  const key = r.pubkey();
  if (tag === 0) return null;
  if (tag !== 1) throw new DecodeError(`invalid COption tag ${tag}`);
  return key;
};

/** `OptionalNonZeroPubkey` / `MaybeNull<Address>`: 32 bytes, all-zero means none. */
const maybeNullPubkey = (r: Reader): Address | null => {
  const key = r.pubkey();
  return key === ZERO_KEY ? null : key;
};

export const EXTENSION_TYPES = [
  'Uninitialized',
  'TransferFeeConfig',
  'TransferFeeAmount',
  'MintCloseAuthority',
  'ConfidentialTransferMint',
  'ConfidentialTransferAccount',
  'DefaultAccountState',
  'ImmutableOwner',
  'MemoTransfer',
  'NonTransferable',
  'InterestBearingConfig',
  'CpiGuard',
  'PermanentDelegate',
  'NonTransferableAccount',
  'TransferHook',
  'TransferHookAccount',
  'ConfidentialTransferFeeConfig',
  'ConfidentialTransferFeeAmount',
  'MetadataPointer',
  'TokenMetadata',
  'GroupPointer',
  'TokenGroup',
  'GroupMemberPointer',
  'TokenGroupMember',
  'ConfidentialMintBurn',
  'ScaledUiAmount',
  'Pausable',
  'PausableAccount',
  'PermissionedBurn',
] as const;

export type ExtensionName = (typeof EXTENSION_TYPES)[number];

export interface TransferFee {
  readonly epoch: bigint;
  readonly maximumFee: bigint;
  readonly transferFeeBasisPoints: number;
}

export type AccountState = 'uninitialized' | 'initialized' | 'frozen';
const accountState = (v: number): AccountState => {
  if (v === 0) return 'uninitialized';
  if (v === 1) return 'initialized';
  if (v === 2) return 'frozen';
  throw new DecodeError(`invalid account state ${v}`);
};

/** Decoded fields per extension. Confidential extensions keep their ciphertexts as hex. */
export interface ExtensionFields {
  TransferFeeConfig: {
    transferFeeConfigAuthority: Address | null;
    withdrawWithheldAuthority: Address | null;
    withheldAmount: bigint;
    olderTransferFee: TransferFee;
    newerTransferFee: TransferFee;
  };
  TransferFeeAmount: { withheldAmount: bigint };
  MintCloseAuthority: { closeAuthority: Address | null };
  ConfidentialTransferMint: { authority: Address | null; autoApproveNewAccounts: boolean; auditorElgamalPubkey: string | null };
  ConfidentialTransferAccount: { raw: string };
  DefaultAccountState: { state: AccountState };
  ImmutableOwner: Record<string, never>;
  MemoTransfer: { requireIncomingTransferMemos: boolean };
  NonTransferable: Record<string, never>;
  InterestBearingConfig: {
    rateAuthority: Address | null;
    initializationTimestamp: bigint;
    preUpdateAverageRate: number;
    lastUpdateTimestamp: bigint;
    currentRate: number;
  };
  CpiGuard: { lockCpi: boolean };
  PermanentDelegate: { delegate: Address | null };
  NonTransferableAccount: Record<string, never>;
  TransferHook: { authority: Address | null; programId: Address | null };
  TransferHookAccount: { transferring: boolean };
  ConfidentialTransferFeeConfig: {
    authority: Address | null;
    withdrawWithheldAuthorityElgamalPubkey: string;
    harvestToMintEnabled: boolean;
    withheldAmount: string;
  };
  ConfidentialTransferFeeAmount: { withheldAmount: string };
  MetadataPointer: { authority: Address | null; metadataAddress: Address | null };
  TokenMetadata: {
    updateAuthority: Address | null;
    mint: Address;
    name: string;
    symbol: string;
    uri: string;
    additionalMetadata: readonly (readonly [string, string])[];
  };
  GroupPointer: { authority: Address | null; groupAddress: Address | null };
  TokenGroup: { updateAuthority: Address | null; mint: Address; size: bigint; maxSize: bigint };
  GroupMemberPointer: { authority: Address | null; memberAddress: Address | null };
  TokenGroupMember: { mint: Address; group: Address; memberNumber: bigint };
  ConfidentialMintBurn: { confidentialSupply: string; decryptableSupply: string; supplyElgamalPubkey: string; pendingBurn: string };
  ScaledUiAmount: { authority: Address | null; multiplier: number; newMultiplierEffectiveTimestamp: bigint; newMultiplier: number };
  Pausable: { authority: Address | null; paused: boolean };
  PausableAccount: Record<string, never>;
  PermissionedBurn: { authority: Address | null };
}

export type KnownExtension = {
  [K in keyof ExtensionFields]: { readonly kind: K; readonly type: number; readonly fields: ExtensionFields[K]; readonly data: string };
}[keyof ExtensionFields];

/** A TLV entry whose type number is not in EXTENSION_TYPES (a newer program). Never dropped: gates reject on it. */
export interface UnknownExtension {
  readonly kind: 'unknown';
  readonly type: number;
  readonly data: string;
}

export type Extension = KnownExtension | UnknownExtension;

const transferFee = (r: Reader): TransferFee => ({ epoch: r.u64(), maximumFee: r.u64(), transferFeeBasisPoints: r.u16() });
const hex = (r: Reader, n: number) => toHex(r.take(n));
const ELGAMAL_PUBKEY = 32;
const ELGAMAL_CIPHERTEXT = 64;
const AE_CIPHERTEXT = 36;

type Readers = { [K in keyof ExtensionFields]: (r: Reader, len: number) => ExtensionFields[K] };

const borshString = (r: Reader) => r.string();

const READERS: Readers = {
  TransferFeeConfig: (r) => ({
    transferFeeConfigAuthority: maybeNullPubkey(r),
    withdrawWithheldAuthority: maybeNullPubkey(r),
    withheldAmount: r.u64(),
    olderTransferFee: transferFee(r),
    newerTransferFee: transferFee(r),
  }),
  TransferFeeAmount: (r) => ({ withheldAmount: r.u64() }),
  MintCloseAuthority: (r) => ({ closeAuthority: maybeNullPubkey(r) }),
  ConfidentialTransferMint: (r) => {
    const authority = maybeNullPubkey(r);
    const autoApproveNewAccounts = r.bool();
    const auditor = r.take(ELGAMAL_PUBKEY);
    return { authority, autoApproveNewAccounts, auditorElgamalPubkey: auditor.every((b) => b === 0) ? null : toHex(auditor) };
  },
  ConfidentialTransferAccount: (r, len) => ({ raw: hex(r, len) }),
  DefaultAccountState: (r) => ({ state: accountState(r.u8()) }),
  ImmutableOwner: () => ({}),
  MemoTransfer: (r) => ({ requireIncomingTransferMemos: r.bool() }),
  NonTransferable: () => ({}),
  InterestBearingConfig: (r) => ({
    rateAuthority: maybeNullPubkey(r),
    initializationTimestamp: r.i64(),
    preUpdateAverageRate: r.i16(),
    lastUpdateTimestamp: r.i64(),
    currentRate: r.i16(),
  }),
  CpiGuard: (r) => ({ lockCpi: r.bool() }),
  PermanentDelegate: (r) => ({ delegate: maybeNullPubkey(r) }),
  NonTransferableAccount: () => ({}),
  TransferHook: (r) => ({ authority: maybeNullPubkey(r), programId: maybeNullPubkey(r) }),
  TransferHookAccount: (r) => ({ transferring: r.bool() }),
  ConfidentialTransferFeeConfig: (r) => ({
    authority: maybeNullPubkey(r),
    withdrawWithheldAuthorityElgamalPubkey: hex(r, ELGAMAL_PUBKEY),
    harvestToMintEnabled: r.bool(),
    withheldAmount: hex(r, ELGAMAL_CIPHERTEXT),
  }),
  ConfidentialTransferFeeAmount: (r) => ({ withheldAmount: hex(r, ELGAMAL_CIPHERTEXT) }),
  MetadataPointer: (r) => ({ authority: maybeNullPubkey(r), metadataAddress: maybeNullPubkey(r) }),
  TokenMetadata: (r) => {
    const updateAuthority = maybeNullPubkey(r);
    const mint = r.pubkey();
    const name = borshString(r);
    const symbol = borshString(r);
    const uri = borshString(r);
    const n = r.u32();
    if (n > r.remaining) throw new DecodeError(`metadata entry count ${n} exceeds the bytes left`);
    const additionalMetadata = Array.from({ length: n }, () => [borshString(r), borshString(r)] as const);
    return { updateAuthority, mint, name, symbol, uri, additionalMetadata };
  },
  GroupPointer: (r) => ({ authority: maybeNullPubkey(r), groupAddress: maybeNullPubkey(r) }),
  TokenGroup: (r) => ({ updateAuthority: maybeNullPubkey(r), mint: r.pubkey(), size: r.u64(), maxSize: r.u64() }),
  GroupMemberPointer: (r) => ({ authority: maybeNullPubkey(r), memberAddress: maybeNullPubkey(r) }),
  TokenGroupMember: (r) => ({ mint: r.pubkey(), group: r.pubkey(), memberNumber: r.u64() }),
  ConfidentialMintBurn: (r) => ({
    confidentialSupply: hex(r, ELGAMAL_CIPHERTEXT),
    decryptableSupply: hex(r, AE_CIPHERTEXT),
    supplyElgamalPubkey: hex(r, ELGAMAL_PUBKEY),
    pendingBurn: hex(r, ELGAMAL_CIPHERTEXT),
  }),
  ScaledUiAmount: (r) => ({ authority: maybeNullPubkey(r), multiplier: r.f64(), newMultiplierEffectiveTimestamp: r.i64(), newMultiplier: r.f64() }),
  Pausable: (r) => ({ authority: maybeNullPubkey(r), paused: r.bool() }),
  PausableAccount: () => ({}),
  PermissionedBurn: (r) => ({ authority: maybeNullPubkey(r) }),
};

/**
 * Walks the TLV area the way token-2022 `try_for_each_tlv_extension_type` does: stop at type 0 or when fewer than
 * 2 bytes remain; an entry whose length runs past the end is corrupt. Fixed-size extensions must use their whole
 * length exactly; TokenMetadata (variable) must fit inside its entry.
 */
const readExtensions = (tlv: Uint8Array): Extension[] => {
  const out: Extension[] = [];
  const r = new Reader(tlv);
  while (r.remaining >= 2) {
    const type = r.u16();
    if (type === 0) break;
    if (r.remaining < 2) throw new DecodeError(`extension ${type} has no length`);
    const len = r.u16();
    const value = r.take(len);
    const name = EXTENSION_TYPES[type];
    if (name === undefined || name === 'Uninitialized') {
      out.push({ kind: 'unknown', type, data: toHex(value) });
      continue;
    }
    const vr = new Reader(value);
    const fields = READERS[name](vr, len);
    if (vr.remaining !== 0 && name !== 'TokenMetadata') {
      throw new DecodeError(`${name} is ${len} bytes; ${vr.remaining} left after its fields`);
    }
    out.push({ kind: name, type, fields, data: toHex(value) } as KnownExtension);
  }
  return out;
};

export interface Mint {
  readonly program: 'spl-token' | 'token-2022';
  readonly mintAuthority: Address | null;
  readonly supply: bigint;
  readonly decimals: number;
  readonly isInitialized: boolean;
  readonly freezeAuthority: Address | null;
  /** Empty for SPL Token mints and for Token-2022 mints without extensions. */
  readonly extensions: readonly Extension[];
}

const tlvStart = (data: Uint8Array, expectedType: number, baseSize: number): number | null => {
  if (data.length === baseSize) return null;
  if (data.length === MULTISIG_SIZE) throw new DecodeError('account is a multisig, not a token account or mint');
  if (data.length < ACCOUNT_SIZE + 1) throw new DecodeError(`extended account must be at least ${ACCOUNT_SIZE + 1} bytes, got ${data.length}`);
  for (let i = baseSize; i < ACCOUNT_SIZE; i++) if (data[i] !== 0) throw new DecodeError('non-zero padding before the account type');
  const accountType = data[ACCOUNT_SIZE]!;
  if (accountType !== expectedType) throw new DecodeError(`account type ${accountType}, expected ${expectedType}`);
  return ACCOUNT_SIZE + 1;
};

/** Decodes a mint owned by `owner` (SPL Token or Token-2022; any other owner is refused, gate H1). */
export const decodeMint = (data: Uint8Array, owner: Address): Mint => {
  const program = owner === TOKEN_PROGRAM ? 'spl-token' : owner === TOKEN_2022_PROGRAM ? 'token-2022' : null;
  if (!program) throw new DecodeError(`mint owner ${owner} is neither SPL Token nor Token-2022`);
  if (data.length < MINT_SIZE) throw new DecodeError(`mint must be at least ${MINT_SIZE} bytes, got ${data.length}`);
  if (program === 'spl-token' && data.length !== MINT_SIZE) throw new DecodeError(`SPL Token mint must be ${MINT_SIZE} bytes`);
  const r = new Reader(data);
  const mintAuthority = cOptionPubkey(r);
  const supply = r.u64();
  const decimals = r.u8();
  const isInitialized = r.bool();
  const freezeAuthority = cOptionPubkey(r);
  if (!isInitialized) throw new DecodeError('mint is not initialized (Mint::unpack refuses it)');
  const start = tlvStart(data, ACCOUNT_TYPE_MINT, MINT_SIZE);
  const extensions = start === null ? [] : readExtensions(data.subarray(start));
  return { program, mintAuthority, supply, decimals, isInitialized, freezeAuthority, extensions };
};

export interface TokenAccount {
  readonly program: 'spl-token' | 'token-2022';
  readonly mint: Address;
  readonly owner: Address;
  readonly amount: bigint;
  readonly delegate: Address | null;
  readonly state: AccountState;
  /** Rent-exempt reserve for wrapped SOL accounts, else null. */
  readonly isNative: bigint | null;
  readonly delegatedAmount: bigint;
  readonly closeAuthority: Address | null;
  readonly extensions: readonly Extension[];
}

/** Decodes a token account (pool vaults read their `amount` here). */
export const decodeTokenAccount = (data: Uint8Array, owner: Address): TokenAccount => {
  const program = owner === TOKEN_PROGRAM ? 'spl-token' : owner === TOKEN_2022_PROGRAM ? 'token-2022' : null;
  if (!program) throw new DecodeError(`token account owner ${owner} is neither SPL Token nor Token-2022`);
  if (data.length < ACCOUNT_SIZE) throw new DecodeError(`token account must be at least ${ACCOUNT_SIZE} bytes, got ${data.length}`);
  if (data.length === MULTISIG_SIZE) throw new DecodeError('account is a multisig, not a token account');
  if (program === 'spl-token' && data.length !== ACCOUNT_SIZE) throw new DecodeError(`SPL Token account must be ${ACCOUNT_SIZE} bytes`);
  const r = new Reader(data);
  const mint = r.pubkey();
  const accountOwner = r.pubkey();
  const amount = r.u64();
  const delegate = cOptionPubkey(r);
  const state = accountState(r.u8());
  if (state === 'uninitialized') throw new DecodeError('token account is not initialized (Account::unpack refuses it)');
  const nativeTag = r.u32();
  const nativeValue = r.u64();
  if (nativeTag > 1) throw new DecodeError(`invalid COption tag ${nativeTag}`);
  const delegatedAmount = r.u64();
  const closeAuthority = cOptionPubkey(r);
  let extensions: Extension[] = [];
  if (data.length > ACCOUNT_SIZE) {
    if (data[ACCOUNT_SIZE] !== ACCOUNT_TYPE_ACCOUNT) throw new DecodeError(`account type ${data[ACCOUNT_SIZE]}, expected ${ACCOUNT_TYPE_ACCOUNT}`);
    extensions = readExtensions(data.subarray(ACCOUNT_SIZE + 1));
  }
  return {
    program,
    mint,
    owner: accountOwner,
    amount,
    delegate,
    state,
    isNative: nativeTag === 1 ? nativeValue : null,
    delegatedAmount,
    closeAuthority,
    extensions,
  };
};
