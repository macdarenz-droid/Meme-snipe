import { describe, expect, it } from 'vitest';
import { decodeBase58 } from '../../src/chain/base58.ts';
import { DecodeError, fromBase64, toHex } from '../../src/chain/bytes.ts';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../src/chain/programs.ts';
import { EXTENSION_TYPES, type Extension, decodeMint, decodeTokenAccount } from '../../src/chain/token.ts';
import { ACCOUNTS, type AccountFixture, accountsLabelled } from './helpers.ts';
import type { Address } from '../../src/chain/bytes.ts';

const u16 = (v: number) => [v & 0xff, v >> 8];
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
const key = (b: number) => Array.from({ length: 32 }, () => b);

/** A Token-2022 mint with no authorities and the given TLV entries. */
const mintWith = (tlv: number[][]): Uint8Array => {
  const base = [...u32(0), ...key(0), ...[1, 0, 0, 0, 0, 0, 0, 0], 6, 1, ...u32(0), ...key(0)];
  const padding = Array.from({ length: 165 - base.length }, () => 0);
  return Uint8Array.from([...base, ...padding, 1, ...tlv.flat()]);
};
const entry = (type: number, value: number[]) => [...u16(type), ...u16(value.length), ...value];

describe('Token-2022 extensions', () => {
  it('decodes an unknown extension type as "unknown" with its bytes, between known ones, never skipped', () => {
    const data = mintWith([entry(18, [...key(0), ...key(9)]), entry(200, [1, 2, 3]), entry(12, key(7))]);
    const m = decodeMint(data, TOKEN_2022_PROGRAM);
    expect(m.extensions.map((e) => e.kind)).toEqual(['MetadataPointer', 'unknown', 'PermanentDelegate']);
    expect(m.extensions[1]).toEqual({ kind: 'unknown', type: 200, data: '010203' });
  });

  it('treats type 0 (Uninitialized) as the end of the list', () => {
    const data = mintWith([entry(9, []), [0, 0, 0, 0], entry(12, key(7))]);
    expect(decodeMint(data, TOKEN_2022_PROGRAM).extensions.map((e) => e.kind)).toEqual(['NonTransferable']);
  });

  it('rejects an entry that runs past the account, a fixed-size entry with the wrong length, and non-zero padding', () => {
    expect(() => decodeMint(mintWith([[...u16(12), ...u16(40), ...key(1)]]), TOKEN_2022_PROGRAM)).toThrow(DecodeError);
    expect(() => decodeMint(mintWith([entry(12, [...key(1), 0])]), TOKEN_2022_PROGRAM)).toThrow(DecodeError);
    const padded = mintWith([]);
    padded[100] = 1;
    expect(() => decodeMint(padded, TOKEN_2022_PROGRAM)).toThrow(DecodeError);
  });

  // Byte sizes of each fixed-size extension, from the struct definitions in token-2022 bb4c841
  // (interface/src/extension/**): each reader must consume exactly this many bytes, and one fewer must fail.
  const SIZES: [string, number][] = [
    ['TransferFeeConfig', 108],
    ['TransferFeeAmount', 8],
    ['MintCloseAuthority', 32],
    ['ConfidentialTransferMint', 65],
    ['DefaultAccountState', 1],
    ['ImmutableOwner', 0],
    ['MemoTransfer', 1],
    ['NonTransferable', 0],
    ['InterestBearingConfig', 52],
    ['CpiGuard', 1],
    ['PermanentDelegate', 32],
    ['NonTransferableAccount', 0],
    ['TransferHook', 64],
    ['TransferHookAccount', 1],
    ['ConfidentialTransferFeeConfig', 129],
    ['ConfidentialTransferFeeAmount', 64],
    ['MetadataPointer', 64],
    ['GroupPointer', 64],
    ['TokenGroup', 80],
    ['GroupMemberPointer', 64],
    ['TokenGroupMember', 72],
    ['ConfidentialMintBurn', 196],
    ['ScaledUiAmount', 56],
    ['Pausable', 33],
    ['PausableAccount', 0],
    ['PermissionedBurn', 32],
  ];

  it('knows all 29 extension types of token-2022 bb4c841, in enum order', () => {
    expect(EXTENSION_TYPES).toHaveLength(29);
    expect(EXTENSION_TYPES[25]).toBe('ScaledUiAmount');
    expect(EXTENSION_TYPES[28]).toBe('PermissionedBurn');
  });

  it.each(SIZES)('%s reads exactly %i bytes', (name, size) => {
    const type = EXTENSION_TYPES.indexOf(name as never);
    // Booleans must be 0 or 1 and account states 0..2, so fill with 1s.
    const value = Array.from({ length: size }, () => 1);
    const m = decodeMint(mintWith([entry(type, value)]), TOKEN_2022_PROGRAM);
    expect(m.extensions.map((e) => e.kind)).toEqual([name]);
    if (size > 0) expect(() => decodeMint(mintWith([entry(type, value.slice(1))]), TOKEN_2022_PROGRAM)).toThrow(DecodeError);
    expect(() => decodeMint(mintWith([entry(type, [...value, 0])]), TOKEN_2022_PROGRAM)).toThrow(DecodeError);
  });

  it('decodes DefaultAccountState, Pausable and ScaledUiAmount fields', () => {
    const f64 = (v: number) => [...new Uint8Array(new Float64Array([v]).buffer)];
    const m = decodeMint(
      mintWith([
        entry(6, [2]),
        entry(26, [...key(0), 1]),
        entry(25, [...key(0), ...f64(1.5), 9, 0, 0, 0, 0, 0, 0, 0, ...f64(2)]),
      ]),
      TOKEN_2022_PROGRAM,
    );
    expect(m.extensions.map((e) => ('fields' in e ? e.fields : null))).toEqual([
      { state: 'frozen' },
      { authority: null, paused: true },
      { authority: null, multiplier: 1.5, newMultiplierEffectiveTimestamp: 9n, newMultiplier: 2 },
    ]);
  });

  it('refuses mints owned by any other program (gate H1)', () => {
    expect(() => decodeMint(mintWith([]), '11111111111111111111111111111111' as Address)).toThrow(DecodeError);
  });
});

/** The RPC's jsonParsed extension list, as [name, state] in our naming. */
const parsedExtensions = (a: AccountFixture) =>
  ((a.parsed?.parsed.info['extensions'] as { extension: string; state?: Record<string, unknown> }[] | undefined) ?? []).map((e) => e.extension);

const rpcName = (e: Extension) => {
  // Agave's account decoder uses camelCase names; a few differ from the program's enum names.
  const map: Record<string, string> = { ScaledUiAmount: 'scaledUiAmountConfig', Pausable: 'pausableConfig', PermissionedBurn: 'permissionedBurnConfig' };
  return e.kind === 'unknown' ? 'unparseableExtension' : (map[e.kind] ?? e.kind[0]!.toLowerCase() + e.kind.slice(1));
};

describe('mints from mainnet', () => {
  const mints = ACCOUNTS.filter((a) => a.parsed?.parsed.type === 'mint');

  it('covers SPL Token mints and Token-2022 mints with extensions', () => {
    expect(mints.some((a) => a.owner === TOKEN_PROGRAM)).toBe(true);
    const withExt = mints.filter((a) => a.owner === TOKEN_2022_PROGRAM && parsedExtensions(a).length > 0);
    expect(withExt.length).toBeGreaterThan(0);
  });

  it.each(mints.map((a) => [a.label, a] as const))('%s matches the RPC parse', (_label, a) => {
    const m = decodeMint(fromBase64(a.dataBase64), a.owner as Address);
    const info = a.parsed!.parsed.info as Record<string, unknown>;
    expect(m.decimals).toBe(info['decimals']);
    expect(m.supply.toString()).toBe(info['supply']);
    expect(m.isInitialized).toBe(info['isInitialized']);
    expect(m.mintAuthority).toBe(info['mintAuthority'] ?? null);
    expect(m.freezeAuthority).toBe(info['freezeAuthority'] ?? null);
    expect(m.extensions.map(rpcName)).toEqual(parsedExtensions(a));
    for (const e of m.extensions) expect(e.kind).not.toBe('unknown');
  });

  it('reads TokenMetadata and pointer fields the same way the RPC does', () => {
    for (const a of mints) {
      const m = decodeMint(fromBase64(a.dataBase64), a.owner as Address);
      const rpc = (a.parsed!.parsed.info['extensions'] as { extension: string; state: Record<string, unknown> }[] | undefined) ?? [];
      for (const e of m.extensions) {
        const r = rpc.find((x) => x.extension === rpcName(e))?.state;
        if (!r) continue;
        if (e.kind === 'TokenMetadata') {
          expect(e.fields.name).toBe(r['name']);
          expect(e.fields.symbol).toBe(r['symbol']);
          expect(e.fields.uri).toBe(r['uri']);
          expect(e.fields.mint).toBe(r['mint']);
          expect(e.fields.updateAuthority).toBe(r['updateAuthority'] ?? null);
          expect(e.fields.additionalMetadata.map(([k, v]) => [k, v])).toEqual(r['additionalMetadata']);
        }
        if (e.kind === 'MetadataPointer') {
          expect(e.fields.authority).toBe(r['authority'] ?? null);
          expect(e.fields.metadataAddress).toBe(r['metadataAddress'] ?? null);
        }
        if (e.kind === 'PermanentDelegate') expect(e.fields.delegate).toBe(r['delegate'] ?? null);
        if (e.kind === 'MintCloseAuthority') expect(e.fields.closeAuthority).toBe(r['closeAuthority'] ?? null);
        if (e.kind === 'TransferHook') {
          expect(e.fields.authority).toBe(r['authority'] ?? null);
          expect(e.fields.programId).toBe(r['programId'] ?? null);
        }
        if (e.kind === 'TransferFeeConfig') {
          expect(e.fields.withheldAmount).toBe(BigInt(r['withheldAmount'] as number));
          const newer = r['newerTransferFee'] as Record<string, number>;
          expect(e.fields.newerTransferFee.transferFeeBasisPoints).toBe(newer['transferFeeBasisPoints']);
          expect(e.fields.newerTransferFee.maximumFee).toBe(BigInt(newer['maximumFee']!));
        }
        if (e.kind === 'DefaultAccountState') expect(e.fields.state).toBe(r['accountState']);
        if (e.kind === 'Pausable') expect(e.fields.paused).toBe(r['paused']);
        if (e.kind === 'ConfidentialTransferMint') expect(e.fields.autoApproveNewAccounts).toBe(r['autoApproveNewAccounts']);
      }
    }
  });
});

describe('token accounts from mainnet', () => {
  it.each(accountsLabelled('canonical pool').filter((a) => a.label.includes('vault')).map((a) => [a.label, a] as const))('%s decodes', (_l, a) => {
    const t = decodeTokenAccount(fromBase64(a.dataBase64), a.owner as Address);
    expect(t.state).toBe('initialized');
    expect(toHex(decodeBase58(t.mint))).toHaveLength(64);
  });
});
