// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { base58, createDecoders, CURVE_MIN_LEN, type DecodedAccount } from '../src/index.ts';
import { accountsOf, bytes, decoders, DEFAULT_PUBKEY, fixture, idls, programOf, role, TOKEN_PROGRAMS, type FixtureAccount } from './fixtures.ts';

const d = decoders();
const PUMP = programOf('pump');
const PSWAP = programOf('pump_amm');
const PFEES = programOf('pump_fees');
const POOLS = ['3Asuat6N', '7Nj7mBE7', '8JZiCe7y', '9GBXHym9', '9ebYNt7c', '9jkXWMyt', 'ArB5efrE', 'CHtrRatG', 'DA4pM4xS', 'Dh39kXkx', 'DreMAMRc', 'FnzKY6x7', 'Hd9zdnVc']
  .map((p) => `mainnet/pumpswap/pools/pool_${p}.json`);
const as = <K extends DecodedAccount['kind']>(a: DecodedAccount, kind: K): Extract<DecodedAccount, { kind: K }> => {
  assert.equal(a.kind, kind);
  return a as Extract<DecodedAccount, { kind: K }>;
};
const SOL = 1_000_000_000n;

describe('A-M02-02 PumpSwap pools', () => {
  it('decodes pools 9jkXWMyt and CHtrRatG with virtual quote reserves 17,584,326,063 and 17,584,505,288 lamports [EX-09]', () => {
    for (const [file, vq] of [[POOLS[5] as string, 17_584_326_063n], [POOLS[7] as string, 17_584_505_288n]] as const) {
      const pool = role(file, 'pool');
      const r = d.decodeAccountWithFlags(pool.owner, bytes(pool));
      const p = as(r.account, 'pumpswap_pool');
      assert.equal(p.virtualQuoteReserves, vq);
      assert.equal(p.baseVault, role(file, 'base_vault').pubkey);
      assert.equal(p.quoteVault, role(file, 'quote_vault').pubkey);
      assert.equal(p.baseMint, role(file, 'base_mint').pubkey);
      assert.equal(p.quoteMint, role(file, 'quote_mint').pubkey);
      assert.equal(p.creator, fixture<{ selection: { pool_authority: string } }>(file).selection.pool_authority);
      assert.equal(r.flags.shortLegacy, false);
    }
  });

  it('decodes all 13 recorded pools; the 30 bytes past the cb188ce layout are protocol_fees, creator_fees and 14 zero bytes (IDL-REPIN)', () => {
    let extended = 0;
    for (const file of POOLS) {
      const pool = role(file, 'pool');
      const r = d.decodeAccountWithFlags(pool.owner, bytes(pool));
      const p = as(r.account, 'pumpswap_pool');
      assert.equal(p.quoteMint, role(file, 'quote_mint').pubkey);                  // wSOL, as C11 recorded it
      assert.ok(p.lpSupply > 0n && p.lpMint.length >= 32);
      assert.equal(bytes(pool).length, 301);                    // the IDL layout is 287 bytes at 8cda1fa (271 at cb188ce)
      if (r.flags.layoutExtended) extended++;
    }
    assert.equal(extended, 0);                                   // was 11 under cb188ce: the bytes it did not describe are fields now
  });

  it('a negative virtual_quote_reserves (i128 high bit set) decodes as a negative bigint [DA-14]', () => {
    const data = bytes(role(POOLS[5] as string, 'pool'));
    data.fill(0xff, 245, 261);
    assert.equal(as(d.decodeAccount(PSWAP, data), 'pumpswap_pool').virtualQuoteReserves, -1n);
  });

  it('checks the owner before dispatch: pool bytes under another program are not a pool', () => {
    const data = bytes(role(POOLS[5] as string, 'pool'));
    assert.deepEqual(d.decodeAccount(PUMP, data), { kind: 'unknown', owner: PUMP, discriminatorHex: 'f19a6d0411b16dbc' });
    assert.deepEqual(d.decodeAccount(DEFAULT_PUBKEY, data), { kind: 'unknown', owner: DEFAULT_PUBKEY, discriminatorHex: 'f19a6d0411b16dbc' });
    assert.equal(d.decodeAccount(TOKEN_PROGRAMS.splToken, data).kind, 'unknown');
  });
});

describe('A-M02-02 fee configs [EX-05, EX-07, EX-08]', () => {
  const fees = (file: string) => {
    const a = accountsOf(file)[0];
    assert.ok(a !== undefined && a.owner === PFEES);
    const r = d.decodeAccountWithFlags(a.owner, bytes(a));
    assert.equal(r.flags.layoutExtended, false);                // the rest is zero capacity
    return as(r.account, 'pump_fee_config');
  };

  it('decodes 25 PumpSwap tiers with the EX-07 boundaries and the 0.30% flat fee', () => {
    const f = fees('mainnet/config/fee_config_pumpswap.json');
    assert.equal(f.tiers.length, 25);
    assert.deepEqual(f.tiers[0], { thresholdLamports: 0n, lpBps: 2, protocolBps: 93, creatorBps: 30 });
    assert.deepEqual(f.tiers[1], { thresholdLamports: 420n * SOL, lpBps: 20, protocolBps: 5, creatorBps: 95 });
    const sol = f.tiers.map((t) => t.thresholdLamports / SOL);
    for (const b of [420n, 1_470n, 2_460n, 3_440n, 4_420n, 9_820n, 14_740n, 98_240n]) assert.ok(sol.includes(b), `${b} SOL`);
    assert.deepEqual(f.tiers.at(-1), { thresholdLamports: 98_240n * SOL, lpBps: 20, protocolBps: 5, creatorBps: 5 });
    const total = f.tiers.map((t) => t.lpBps + t.protocolBps + t.creatorBps);
    assert.deepEqual(total.slice(0, 7), [125, 120, 115, 110, 105, 100, 95]);
    assert.deepEqual(f.flat, { lpBps: 25, protocolBps: 5, creatorBps: 0 });
    assert.ok(Array.isArray(f.raw.stable_fee_tiers));          // stable tiers only in raw (USDC pools are excluded)
  });

  it('decodes the curve fee config: one tier, 0/95/30 = 1.25%', () => {
    const f = fees('mainnet/config/fee_config_curve.json');
    assert.deepEqual(f.tiers, [{ thresholdLamports: 0n, lpBps: 0, protocolBps: 95, creatorBps: 30 }]);
  });

  it('a fee above 10,000 bps or a threshold above u64 is unknown (fail closed)', () => {
    const a = accountsOf('mainnet/config/fee_config_pumpswap.json')[0] as FixtureAccount;
    const lp = bytes(a);
    lp.set([0x11, 0x27], 85);                                  // first tier lp_fee_bps = 10,001
    assert.equal(d.decodeAccount(PFEES, lp).kind, 'unknown');
    const flat = bytes(a);
    flat.set([0x11, 0x27], 41);                                // flat lp_fee_bps = 10,001
    assert.equal(d.decodeAccount(PFEES, flat).kind, 'unknown');
    const big = bytes(a);
    big[77] = 1;                                               // first threshold ≥ 2^64
    assert.equal(d.decodeAccount(PFEES, big).kind, 'unknown');
  });
});

describe('A-M02-02 pump bonding curves [DA-13, DA-15, DA-V01]', () => {
  const curve = (f: string) => role(`mainnet/pump/curves/${f}`, 'bonding_curve');

  it('decodes current curves; quote_mint all zeros (SOL) is returned as null, the native-SOL marker (Z03 m6)', () => {
    const r = d.decodeAccountWithFlags(PUMP, bytes(curve('curve_586AJyoo.json')));
    const c = as(r.account, 'pump_bonding_curve');
    assert.equal(c.complete, false);
    assert.equal(c.quoteMint, null);                                                   // was DEFAULT_PUBKEY before Z03 m6
    assert.ok(c.virtualQuote > c.realQuote && c.virtualToken > c.realToken);
    assert.deepEqual(r.flags, { layoutExtended: false, shortLegacy: true });   // 143 bytes: inside the fields 8cda1fa appends, zero there (IDL-REPIN)
    const done = as(d.decodeAccount(PUMP, bytes(curve('curve_9ergzzPt.json'))), 'pump_bonding_curve');
    assert.equal(done.complete, true);
    assert.equal(done.realToken, 0n);
  });

  it('a short legacy curve (derived from a recorded one) reads missing trailing fields as 0 / false / default', () => {
    const full = bytes(curve('curve_586AJyoo.json'));
    const ref = as(d.decodeAccount(PUMP, full), 'pump_bonding_curve');
    const through = (n: number) => d.decodeAccountWithFlags(PUMP, full.slice(0, n));
    const withCreator = through(81);                           // discriminator, five u64, complete, creator
    assert.deepEqual(withCreator, {
      account: { ...ref, quoteMint: null }, flags: { layoutExtended: false, shortLegacy: true },
    });
    const oldest = through(CURVE_MIN_LEN);
    assert.deepEqual(oldest.account, { ...ref, creator: DEFAULT_PUBKEY, quoteMint: null });
    assert.equal(oldest.flags.shortLegacy, true);
    assert.deepEqual(through(CURVE_MIN_LEN - 1).account, { kind: 'unknown', owner: PUMP, discriminatorHex: '17b7f83760d8ac60' });
  });

  it('pads a short curve only when it ends on a field boundary of the pinned layout; any other length is unknown (review C03-R1-4)', () => {
    const full = bytes(curve('curve_586AJyoo.json'));
    // complete 49, creator 81, is_mayhem_mode 82, is_cashback_coin 83, quote_mint 115, creator_fee_bps 123,
    // can_edit_creator_fee 124; is_holder_reward ends the full 125-byte layout.
    const boundaries = [49, 81, 82, 83, 115, 123, 124];
    for (let n = CURVE_MIN_LEN; n < 125; n++) {
      const r = d.decodeAccountWithFlags(PUMP, full.slice(0, n));
      if (boundaries.includes(n)) {
        assert.equal(r.account.kind, 'pump_bonding_curve', `${n} bytes`);
        assert.equal(r.flags.shortLegacy, true, `${n} bytes`);
      } else {
        assert.deepEqual(r, { account: { kind: 'unknown', owner: PUMP, discriminatorHex: '17b7f83760d8ac60' }, flags: { layoutExtended: false, shortLegacy: false } }, `${n} bytes`);
      }
    }
    // 125 bytes ended the cb188ce layout; at 8cda1fa the curve's appended fields read as 0 from there (IDL-REPIN).
    assert.deepEqual(d.decodeAccountWithFlags(PUMP, full.slice(0, 125)).flags, { layoutExtended: false, shortLegacy: true });
  });
});

describe('A-M02-02 configs and globals', () => {
  it('decodes the PumpSwap global config (disable_flags 0) and the pump global', () => {
    const g = role('mainnet/config/pumpswap_global_config.json', 'pumpswap_global_config');
    const gc = as(d.decodeAccount(g.owner, bytes(g)), 'pumpswap_global_config');
    assert.equal(gc.disableFlags, 0);
    assert.equal(gc.raw.boost_enabled, true);                  // [EX-V01]
    const p = role('mainnet/config/pump_global.json', 'pump_global');
    const pg = as(d.decodeAccount(p.owner, bytes(p)), 'pump_global');
    assert.equal(typeof pg.raw.fee_basis_points, 'bigint');
  });

  it('a pinned type without a variant, an unknown discriminator and data under 8 bytes are unknown', () => {
    const fee = bytes(accountsOf('mainnet/config/fee_config_curve.json')[0] as FixtureAccount);
    assert.deepEqual(d.decodeAccount(PUMP, fee), { kind: 'unknown', owner: PUMP, discriminatorHex: '8f3492bbdb7b4c9b' });
    assert.deepEqual(d.decodeAccount(PUMP, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])), { kind: 'unknown', owner: PUMP, discriminatorHex: '0102030405060708' });
    assert.deepEqual(d.decodeAccount(PUMP, Uint8Array.from([1, 2])), { kind: 'unknown', owner: PUMP, discriminatorHex: '' });
    assert.deepEqual(d.decodeAccount(DEFAULT_PUBKEY, Uint8Array.from([1, 2])), { kind: 'unknown', owner: DEFAULT_PUBKEY, discriminatorHex: '' });
    const pool = bytes(role(POOLS[0] as string, 'pool')).slice(0, 100);
    assert.equal(d.decodeAccount(PSWAP, pool).kind, 'unknown');  // shorter than the minimum: not a legacy type
  });
});

describe('A-M02-02 SPL Token and Token-2022', () => {
  it('a just-created pump mint: Token-2022, decimals 6, supply 1,000,000,000,000,000, no authorities [TH-V01]', () => {
    const all = accountsOf('decoders/token2022/pump_mint_fresh.json') as Array<FixtureAccount & { create_signature?: string }>;
    const created = all.filter((a) => a.create_signature !== undefined);
    assert.equal(created.length, 1);                            // recorded right after its create transaction (README)
    for (const a of all) {
      assert.equal(a.owner, TOKEN_PROGRAMS.token2022);
      const data = bytes(a);
      const m = as(d.decodeAccount(a.owner, data), 'spl_mint');
      // The fresh mint holds the created supply; the two older mints on their curves hold less (holders burned tokens).
      const supply = a.create_signature === undefined ? Buffer.from(data).readBigUInt64LE(36) : 1_000_000_000_000_000n;
      assert.deepEqual(m, {
        kind: 'spl_mint', tokenProgram: 'token_2022', mintAuthority: null, supply, decimals: 6,
        isInitialized: true, freezeAuthority: null, extensionBytes: data.length - 82,
      });
      if (a.create_signature === undefined) assert.ok(m.supply < 1_000_000_000_000_000n);
    }
  });

  it('decodes the wSOL mint (SPL Token, 82 bytes) and the vaults of a pool', () => {
    const file = POOLS[5] as string;
    const wsol = as(d.decodeAccount(TOKEN_PROGRAMS.splToken, bytes(role(file, 'quote_mint'))), 'spl_mint');
    assert.deepEqual([wsol.tokenProgram, wsol.decimals, wsol.extensionBytes], ['spl_token', 9, 0]);
    for (const v of ['base_vault', 'quote_vault']) {
      const a = role(file, v);
      const t = as(d.decodeAccount(a.owner, bytes(a)), 'spl_token_account');
      assert.equal(t.owner, role(file, 'pool').pubkey);
      assert.equal(t.state, 'initialized');
      assert.equal(t.delegate, null);
    }
  });

  it('reads the frozen state, a delegate, and refuses an uninitialized account or a bad COption tag', () => {
    const vault = bytes(role(POOLS[5] as string, 'quote_vault'));
    const frozen = vault.slice();
    frozen[108] = 2;
    assert.equal(as(d.decodeAccount(TOKEN_PROGRAMS.splToken, frozen), 'spl_token_account').state, 'frozen');
    const delegated = vault.slice();
    delegated.set([1, 0, 0, 0], 72);
    delegated.fill(7, 76, 108);
    assert.equal(as(d.decodeAccount(TOKEN_PROGRAMS.splToken, delegated), 'spl_token_account').delegate, base58.encode(new Uint8Array(32).fill(7)));
    const uninit = vault.slice();
    uninit[108] = 0;
    assert.deepEqual(d.decodeAccount(TOKEN_PROGRAMS.splToken, uninit), { kind: 'unknown', owner: TOKEN_PROGRAMS.splToken, discriminatorHex: '' });
    const badTag = vault.slice();
    badTag[72] = 2;
    assert.equal(d.decodeAccount(TOKEN_PROGRAMS.splToken, badTag).kind, 'unknown');
    const mint = bytes(role(POOLS[5] as string, 'quote_mint'));
    mint[45] = 2;                                              // is_initialized must be 0 or 1
    assert.equal(d.decodeAccount(TOKEN_PROGRAMS.splToken, mint).kind, 'unknown');
  });

  it('dispatches Token-2022 extended accounts by their AccountType byte; anything else is unknown', () => {
    const t22 = TOKEN_PROGRAMS.token2022;
    const mint = bytes(role(POOLS[5] as string, 'base_mint'));
    const padded = mint.slice();
    padded[100] = 1;                                           // padding must be zero
    assert.equal(d.decodeAccount(t22, padded).kind, 'unknown');
    const typeless = mint.slice();
    typeless[165] = 3;
    assert.equal(d.decodeAccount(t22, typeless).kind, 'unknown');
    assert.equal(d.decodeAccount(t22, new Uint8Array(355)).kind, 'unknown');               // multisig
    const vault = bytes(role(POOLS[5] as string, 'base_vault'));                           // 170 bytes, AccountType 2
    assert.equal(d.decodeAccount(t22, vault).kind, 'spl_token_account');
    assert.equal(d.decodeAccount(TOKEN_PROGRAMS.splToken, vault).kind, 'unknown');         // SPL Token has no extensions
    assert.equal(d.decodeAccount(t22, new Uint8Array(120)).kind, 'unknown');
  });

  it('without token program IDs, token accounts are unknown; metrics count every decode', () => {
    const counts: string[] = [];
    const plain = createDecoders(idls(), { metrics: { counter: (_n, l) => ({ inc: () => { counts.push(`${l.kind}:${l.result}`); } }) } });
    const a = role(POOLS[5] as string, 'quote_vault');
    assert.equal(plain.decodeAccount(a.owner, bytes(a)).kind, 'unknown');
    const pool = role(POOLS[5] as string, 'pool');
    plain.decodeAccount(pool.owner, bytes(pool));
    assert.deepEqual(counts, ['unknown:unknown', 'pumpswap_pool:ok']);
  });
});

describe('A-M02-02 robustness (property)', () => {
  it('never throws on random bytes, under any owner, with or without a valid discriminator', () => {
    const owners = [PUMP, PSWAP, PFEES, TOKEN_PROGRAMS.splToken, TOKEN_PROGRAMS.token2022, DEFAULT_PUBKEY];
    const discs = [...idls().flatMap((i) => [...i.accounts.keys()])].map((h) => Uint8Array.from(Buffer.from(h, 'hex')));
    fc.assert(fc.property(fc.constantFrom(...owners), fc.option(fc.constantFrom(...discs)), fc.uint8Array({ maxLength: 600 }), (owner, disc, rest) => {
      const data = disc === null ? rest : Uint8Array.from([...disc, ...rest]);
      const r = d.decodeAccountWithFlags(owner, data);
      assert.equal(typeof r.account.kind, 'string');
    }), { numRuns: 2_000 });
  });
});
