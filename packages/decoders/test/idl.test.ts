// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import {
  compileIdl, createDecoders, DEFAULT_IDL_DIR, IDL_COMMIT, PINNED_IDLS, Reader, UnknownProgramError, VENDORED_IDL_DIR,
  verifyPinnedIdls, type IdlError, type PinnedIdl, type PinnedIdlSpec,
} from '../src/index.ts';
import { DEFAULT_PUBKEY } from './fixtures.ts';

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
function copyIdls(): string {
  const d = mkdtempSync(join(tmpdir(), 'idl-'));
  temps.push(d);
  cpSync(VENDORED_IDL_DIR, d, { recursive: true });
  return d;
}
const loaded = (): PinnedIdl[] => {
  const r = verifyPinnedIdls(VENDORED_IDL_DIR);
  assert.ok(r.ok);
  return r.value;
};
const hex = (b: readonly number[]): string => Buffer.from(b).toString('hex');

describe('A-M02-01 pinned IDLs', () => {
  it('verifies the three vendored IDLs at the pinned commit; the pump TradeEvent discriminator matches [DA-16]', () => {
    const events: Array<[string, string]> = [];
    const r = verifyPinnedIdls(`${VENDORED_IDL_DIR}/`, { event: (_l, c, f) => { events.push([c, String(f.sha256)]); } });
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((i) => [i.name, i.file, i.commit]), [
      ['pump', 'pump.json', IDL_COMMIT], ['pump_amm', 'pump_amm.json', IDL_COMMIT], ['pump_fees', 'pump_fees.json', IDL_COMMIT]]);
    assert.equal(IDL_COMMIT, '8cda1fa30ea658b20909d8aedf002047119388d2');
    const pump = r.value[0] as PinnedIdl;
    assert.equal(pump.events.get(hex([189, 219, 127, 211, 78, 230, 97, 238]))?.name, 'TradeEvent');
    assert.deepEqual(events.map((e) => e[0]), ['m02.idl_verified', 'm02.idl_verified', 'm02.idl_verified']);
    for (const [i, pin] of PINNED_IDLS.entries()) {
      assert.equal(createHash('sha256').update(readFileSync(join(VENDORED_IDL_DIR, pin.file))).digest('hex'), pin.sha256);
      assert.equal(events[i]?.[1], pin.sha256);
    }
    assert.equal(DEFAULT_IDL_DIR, '/opt/bot/idl');
  });

  it('one byte of pump_amm.json changed → E_IDL_HASH with expected and actual hashes, logged critical', () => {
    const d = copyIdls();
    const file = join(d, 'pump_amm.json');
    const bytes = readFileSync(file);
    bytes[100] = (bytes[100] as number) ^ 0x01;
    writeFileSync(file, bytes);
    const logged: string[] = [];
    const r = verifyPinnedIdls(d, { event: (level, code) => { logged.push(`${level} ${code}`); } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'E_IDL_HASH');
    assert.equal(r.error.file, 'pump_amm.json');
    assert.equal(r.error.expected, 'b7d8c57a4d9c4dd0109a9ab893052352333252d4eedced10ac091d4d66cab89b');
    assert.equal(r.error.actual, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(logged, ['critical m02.idl_hash_mismatch']);
  });

  it('a missing file → E_IDL_MISSING', () => {
    const d = copyIdls();
    unlinkSync(join(d, 'pump_fees.json'));
    assert.deepEqual(verifyPinnedIdls(d), { ok: false, error: { code: 'E_IDL_MISSING', file: 'pump_fees.json' } });
    assert.deepEqual(readdirSync(d).sort(), ['pump.json', 'pump_amm.json']);
  });

  it('a hash-verified IDL that does not compile stops the load (E_IDL_PARSE)', () => {
    const d = copyIdls();
    const text = '{"address":1}';
    writeFileSync(join(d, 'bad.json'), text);
    const pin = { name: 'pump', file: 'bad.json', sha256: createHash('sha256').update(text).digest('hex'), accounts: [], events: [] } as const;
    const r = verifyPinnedIdls(d, undefined, [pin]);
    assert.deepEqual(r, { ok: false, error: { code: 'E_IDL_PARSE', file: 'bad.json', message: 'address missing' } });
  });

  it('a startup harness simulating the M26 refusal path refuses to start on a tampered IDL', () => {
    // M26 (group B) reports start_refused with reason idl_hash to the sentinel and exits (ARCH M02, 7.6).
    const bootstrap = (dir: string): { started: boolean; refused: { reason: string } | null } => {
      const r = verifyPinnedIdls(dir);
      if (r.ok) return { started: true, refused: null };
      return { started: false, refused: { reason: r.error.code === 'E_IDL_HASH' ? 'idl_hash' : 'idl_invalid' } };
    };
    assert.deepEqual(bootstrap(VENDORED_IDL_DIR), { started: true, refused: null });
    const d = copyIdls();
    writeFileSync(join(d, 'pump.json'), `${readFileSync(join(d, 'pump.json'), 'utf8')} `);
    assert.deepEqual(bootstrap(d), { started: false, refused: { reason: 'idl_hash' } });
    unlinkSync(join(d, 'pump.json'));
    assert.deepEqual(bootstrap(d), { started: false, refused: { reason: 'idl_invalid' } });
  });

  it('the decoder registry reports the pinned version per program', () => {
    const idls = loaded();
    const d = createDecoders(idls);
    for (const idl of idls) assert.deepEqual(d.idlVersion(idl.program), { commit: IDL_COMMIT, sha256: idl.sha256 });
    assert.throws(() => d.idlVersion(DEFAULT_PUBKEY), (e: unknown) => e instanceof UnknownProgramError && e.code === 'E_UNKNOWN_PROGRAM');
  });

  it('compiles reader plans for every account, event and instruction', () => {
    const [pump] = loaded();
    const curve = [...(pump as PinnedIdl).accounts.values()].find((t) => t.name === 'BondingCurve');
    assert.deepEqual(curve?.fields.map((f) => f.name).slice(0, 6),
      ['virtual_token_reserves', 'virtual_quote_reserves', 'real_token_reserves', 'real_quote_reserves', 'token_total_supply', 'complete']);
    const buy = [...(pump as PinnedIdl).instructions.values()].find((i) => i.name === 'buy');
    assert.ok(buy !== undefined && buy.accounts.length > 5 && buy.args.length >= 2);
  });
});

describe('A-M02-01 IDL compiler (fail closed)', () => {
  const pin: PinnedIdlSpec = { name: 'pump', file: 'x.json', sha256: 'h', accounts: [], events: [] };
  const base = () => ({
    address: DEFAULT_PUBKEY,
    instructions: [{ name: 'go', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [{ name: 'a' }], args: [{ name: 'n', type: 'u8' }] }],
    accounts: [{ name: 'S', discriminator: [9, 9, 9, 9, 9, 9, 9, 9] }],
    events: [{ name: 'E', discriminator: [8, 8, 8, 8, 8, 8, 8, 8] }],
    types: [
      { name: 'S', type: { kind: 'struct', fields: [{ name: 'a', type: 'u64' }, { name: 'o', type: { option: 'pubkey' } }, { name: 'v', type: { vec: 'u16' } },
        { name: 'arr', type: { array: ['u8', 2] } }, { name: 'e', type: { defined: { name: 'En' } } }, { name: 'd', type: { defined: 'En' } }] } },
      { name: 'En', type: { kind: 'enum', variants: [{ name: 'A' }, { name: 'B', fields: [{ name: 'x', type: 'i32' }] }, { name: 'C', fields: ['bool', 'string'] }] } },
      { name: 'E', type: { kind: 'struct' } },
    ],
  });
  const run = (mutate: (d: ReturnType<typeof base>) => void): string => {
    const d = base();
    mutate(d);
    const r = compileIdl(JSON.stringify(d), pin, 'h');
    return r.ok ? 'ok' : (r.error as IdlError).message as string;
  };

  it('decodes structs, options, vectors, arrays and enums with their Borsh encodings', () => {
    const r = compileIdl(JSON.stringify(base()), pin, 'h');
    assert.ok(r.ok);
    const s = r.value.accounts.get('0909090909090909');
    const data = Uint8Array.from([
      5, 0, 0, 0, 0, 0, 0, 0, 1, ...new Array<number>(32).fill(0), 2, 0, 0, 0, 7, 0, 8, 0, 3, 4,
      0, 1, 0xff, 0xff, 0xff, 0xff,
    ]);
    assert.deepEqual(s?.read(new Reader(data)), {
      a: 5n, o: DEFAULT_PUBKEY, v: [7, 8], arr: [3, 4], e: 'A', d: { variant: 'B', fields: { x: -1 } },
    });
    const en = s?.fields.find((f) => f.name === 'e');
    assert.deepEqual(en?.read(new Reader(Uint8Array.from([2, 1, 1, 0, 0, 0, 0x7a]))), { variant: 'C', fields: { 0: true, 1: 'z' } });
    assert.throws(() => en?.read(new Reader(Uint8Array.from([3]))), /variant 3 does not exist/);
    const o = s?.fields.find((f) => f.name === 'o');
    assert.equal(o?.read(new Reader(Uint8Array.from([0]))), null);
    assert.throws(() => o?.read(new Reader(Uint8Array.from([2]))), /option tag/);
    const v = s?.fields.find((f) => f.name === 'v');
    assert.throws(() => v?.read(new Reader(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))), /vector too long/);
    assert.deepEqual(r.value.instructions.get('0102030405060708')?.args.map((a) => a.name), ['n']);
    assert.deepEqual(r.value.events.get('0808080808080808')?.read(new Reader(new Uint8Array(0))), {});
  });

  it('reads every Borsh primitive the IDLs use', () => {
    const prims = ['bool', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'u128', 'i128', 'pubkey', 'string', 'bytes'];
    const d = base();
    (d.types as unknown[]).push({ name: 'All', type: { kind: 'struct', fields: prims.map((p) => ({ name: p, type: p })) } });
    d.accounts.push({ name: 'All', discriminator: [6, 6, 6, 6, 6, 6, 6, 6] });
    const r = compileIdl(JSON.stringify(d), pin, 'h');
    assert.ok(r.ok);
    const data = Uint8Array.from([
      1, 2, 0xfe, 3, 0, 0xfd, 0xff, 4, 0, 0, 0, 0xfc, 0xff, 0xff, 0xff, 5, 0, 0, 0, 0, 0, 0, 0, ...new Array<number>(8).fill(0xff),
      6, ...new Array<number>(15).fill(0), ...new Array<number>(16).fill(0xff), ...new Array<number>(32).fill(0), 1, 0, 0, 0, 0x71, 2, 0, 0, 0, 7, 8,
    ]);
    assert.deepEqual(r.value.accounts.get('0606060606060606')?.read(new Reader(data)), {
      bool: true, u8: 2, i8: -2, u16: 3, i16: -3, u32: 4, i32: -4, u64: 5n, i64: -1n, u128: 6n, i128: -1n,
      pubkey: DEFAULT_PUBKEY, string: 'q', bytes: Uint8Array.from([7, 8]),
    });
  });

  it('refuses every unsupported or malformed construct', () => {
    const cases: Array<[string, (d: ReturnType<typeof base>) => void]> = [
      ['address missing', (d) => { delete (d as { address?: string }).address; }],
      ['address is not a public key', (d) => { d.address = 'abc'; }],
      ['types must be a list', (d) => { (d as unknown as { types: unknown }).types = {}; }],
      ['a type needs a name', (d) => { (d.types as unknown[]).push({ name: 'X' }); }],
      ['serialization bytemuck', (d) => { (d.types as unknown[]).push({ name: 'X', serialization: 'bytemuck', type: { kind: 'struct' } }); }],
      ['generics are not supported', (d) => { (d.types as unknown[]).push({ name: 'X', generics: [], type: { kind: 'struct' } }); }],
      ['defined twice', (d) => { (d.types as unknown[]).push({ name: 'E', type: { kind: 'struct' } }); }],
      ['kind type is not supported', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'type', alias: 'u8' }; }],
      ['an enum needs 1-256 variants', (d) => { (d.types[1] as { type: unknown }).type = { kind: 'enum', variants: [] }; }],
      ['bad variant', (d) => { (d.types[1] as { type: unknown }).type = { kind: 'enum', variants: [7] }; }],
      ['fields must be a list', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: {} }; }],
      ['type f32 is not supported', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: 'f32' }] }; }],
      ['bad type', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: 7 }] }; }],
      ['bad type', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { vec: 'u8', option: 'u8' } }] }; }],
      ['type coption is not supported', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { coption: 'u8' } }] }; }],
      ['an array needs [type, length]', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { array: ['u8', { generic: 'N' }] } }] }; }],
      ['an array needs [type, length]', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { array: 'u8' } }] }; }],
      ['an array needs [type, length]', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { array: ['u8', -1] } }] }; }],
      ['an array needs [type, length]', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { array: ['u8', 70_000] } }] }; }],
      ['bad defined type', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { defined: { name: 'En', generics: [] } } }] }; }],
      ['bad defined type', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { defined: 7 } }] }; }],
      ['type Nope is not defined', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { defined: 'Nope' } }] }; }],
      ['recursive types are not supported', (d) => { (d.types[2] as { type: unknown }).type = { kind: 'struct', fields: [{ name: 'f', type: { option: { defined: 'E' } } }] }; }],
      ['accounts must be a list', (d) => { (d as unknown as { accounts: unknown }).accounts = 1; }],
      ['an entry needs a name', (d) => { (d.accounts as unknown[]).push({}); }],
      ['a discriminator is 8 bytes', (d) => { (d.events[0] as { discriminator: unknown }).discriminator = [1, 2, 3]; }],
      ['a discriminator is 8 bytes', (d) => { (d.events[0] as { discriminator: unknown }).discriminator = [1, 2, 3, 4, 5, 6, 7, 256]; }],
      ['listed twice', (d) => { d.events.push({ name: 'E', discriminator: [7, 7, 7, 7, 7, 7, 7, 7] }); }],
      ['is used twice', (d) => { d.accounts.push({ name: 'E', discriminator: [9, 9, 9, 9, 9, 9, 9, 9] }); }],
      ['instructions must be a list', (d) => { (d as unknown as { instructions: unknown }).instructions = null; }],
      ['an instruction needs a name and accounts', (d) => { (d.instructions as unknown[]).push({ name: 'x' }); }],
      ['bad account', (d) => { (d.instructions[0] as { accounts: unknown[] }).accounts.push(5); }],
      ['instructions.go2: discriminator 0102030405060708 is used twice', (d) => { d.instructions.push({ ...(d.instructions[0] as { name: string }), name: 'go2' } as never); }],
    ];
    for (const [want, mutate] of cases) assert.ok(run(mutate).includes(want), `${want}: got ${run(mutate)}`);
    assert.deepEqual(compileIdl('{not json', pin, 'h'), { ok: false, error: { code: 'E_IDL_PARSE', file: 'x.json', message: 'not JSON' } });
    for (const text of ['[]', '5', 'null']) assert.deepEqual(compileIdl(text, pin, 'h'), { ok: false, error: { code: 'E_IDL_PARSE', file: 'x.json', message: 'the IDL must be an object' } });
    const missing = compileIdl(JSON.stringify(base()), { ...pin, accounts: ['Pool'] }, 'h');
    assert.ok(!missing.ok && missing.error.message === 'account Pool is missing');
    const missingEvent = compileIdl(JSON.stringify(base()), { ...pin, events: ['BuyEvent'] }, 'h');
    assert.ok(!missingEvent.ok && missingEvent.error.message === 'event BuyEvent is missing');
  });
});

describe('A-M02-01 zero dependencies (C-02)', () => {
  it('the package declares only internal packages and its sources import only node: built-ins and @bot/types', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
      for (const dep of Object.keys(manifest[field] ?? {})) assert.ok(dep.startsWith('@bot/'), `${field}.${dep}`);
    }
    const src = new URL('../src/', import.meta.url);
    for (const f of readdirSync(src)) {
      const text = readFileSync(new URL(f, src), 'utf8');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
        const spec = m[1] as string;
        assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec === '@bot/types', `${f}: ${spec}`);
      }
    }
  });
});
