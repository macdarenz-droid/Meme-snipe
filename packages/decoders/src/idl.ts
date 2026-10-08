// Pinned IDL loader, hash verification and reader plans (A-M02-01). Discriminators are read from the IDL JSON, never
// recomputed from names [DA-16]. Every type definition is compiled once into a reader plan; a construct this compiler
// does not support fails the load (`E_IDL_PARSE`, fail closed). No code is generated from IDL contents.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pubkey, Result } from '@bot/types';
import { DecodeError, decodePubkey, Reader, toHex } from './codec.ts';

/**
 * Pinned inputs: `pump-fun/pump-public-docs` at commit cb188ce08b5069196eef1f3e4a0c43b70099793b (2026-09-29, the
 * repository head on 2026-10-07; the three IDL files last changed in e0687ae9b7e064a0f54efc7297c65eecfbba3a8f,
 * 2026-09-12). VERIFY U-A09 (DA-11 could not confirm the SHA): read with `git log` from
 * https://github.com/pump-fun/pump-public-docs on 2026-10-07. Files: idl/pump.json, idl/pump_amm.json and
 * idl/pump_fees.json, vendored byte for byte in packages/decoders/idl/. A change to a file or to these hashes is a
 * reviewed commit.
 */
export const IDL_COMMIT = 'cb188ce08b5069196eef1f3e4a0c43b70099793b';
export const PINNED_IDLS: ReadonlyArray<{ name: 'pump' | 'pump_amm' | 'pump_fees'; file: string; sha256: string; accounts: readonly string[]; events: readonly string[] }> = [
  {
    name: 'pump', file: 'pump.json', sha256: 'ffe966c42f1af41652ee753fe2f1e3f7cd4077d7e6f49faf3138959c8b56064b',
    accounts: ['BondingCurve', 'Global'], events: ['TradeEvent', 'CompleteEvent', 'CompletePumpAmmMigrationEvent'],
  },
  {
    name: 'pump_amm', file: 'pump_amm.json', sha256: '2091433899b07d003d98118ae6cd3c628960fd393b40710b6e15bce6d0e7f2d1',
    accounts: ['Pool', 'GlobalConfig'], events: ['BuyEvent', 'SellEvent', 'InitBoostEvent'],
  },
  {
    name: 'pump_fees', file: 'pump_fees.json', sha256: 'd87b52305fd6b2ec487d4ba1e08a49990c23fa9b8b76092b2097df0164fa3859',
    accounts: ['FeeConfig'], events: [],
  },
];

/** `decoders.idl_dir` default on the host (root-owned, read-only). */
export const DEFAULT_IDL_DIR = '/opt/bot/idl';
/** The copies vendored in this package. */
export const VENDORED_IDL_DIR = fileURLToPath(new URL('../idl/', import.meta.url));

/** A compiled reader plan: reads one value of a type. */
export type Plan = (r: Reader) => unknown;
export interface FieldPlan { name: string; read: Plan }
export interface IdlTypeDef { name: string; fields: readonly FieldPlan[]; read: Plan }
export interface IdlInstrDef { name: string; accounts: readonly string[]; args: readonly FieldPlan[] }

export interface PinnedIdl {
  name: 'pump' | 'pump_amm' | 'pump_fees';
  program: Pubkey;            // the IDL's `address`, covered by the pinned hash
  file: string; commit: string; sha256: string;
  accounts: Map<string, IdlTypeDef>;        // key: discriminator hex
  events: Map<string, IdlTypeDef>;
  instructions: Map<string, IdlInstrDef>;
  /**
   * The instructions whose `quote_mint` account the IDL binds to the pool (`relations: ["pool"]`, Anchor `has_one`), by
   * discriminator hex, with that account's index (Z03 ruling 14): the only instructions trusted for a PumpSwap trade's
   * quote mint. Built here, at load, from the hash-verified IDL.
   */
  poolQuoteMint: Map<string, number>;
}

export type IdlErrorCode = 'E_IDL_HASH' | 'E_IDL_MISSING' | 'E_IDL_PARSE';
export interface IdlError { code: IdlErrorCode; file: string; expected?: string; actual?: string; message?: string }

/** Logs `m02.idl_verified` and `m02.idl_hash_mismatch` (M27 `log.event`; codes in `M02_LOG_CODES`). */
export interface IdlLog { event(level: 'info' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void }

class ParseError extends Error {}
const fail = (message: string): never => { throw new ParseError(message); };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const PRIMITIVES: Readonly<Record<string, Plan>> = {
  bool: (r) => r.bool(),
  u8: (r) => r.u8(), i8: (r) => r.i8(), u16: (r) => r.u16(), i16: (r) => r.i16(), u32: (r) => r.u32(), i32: (r) => r.i32(),
  u64: (r) => r.u64(), i64: (r) => r.i64(), u128: (r) => r.u128(), i128: (r) => r.i128(),
  pubkey: (r) => r.pubkey(), string: (r) => r.string(), bytes: (r) => r.bytes(r.u32()),
};
const MAX_VEC = 65_536;                // a length above this in decoded data is treated as corrupt (bounds the work)

/** Compiles the `types` of one IDL into reader plans. */
class Compiler {
  private readonly raw = new Map<string, Record<string, unknown>>();
  private readonly done = new Map<string, IdlTypeDef>();
  private readonly active = new Set<string>();
  constructor(types: unknown) {
    if (!Array.isArray(types)) fail('types must be a list');
    for (const t of types as unknown[]) {
      if (!isObject(t) || typeof t.name !== 'string' || !isObject(t.type)) fail('a type needs a name and a type');
      const def = t as { name: string; type: Record<string, unknown>; serialization?: unknown; generics?: unknown };
      if (def.serialization !== undefined && def.serialization !== 'borsh') fail(`${def.name}: serialization ${String(def.serialization)} is not supported`);
      if (def.generics !== undefined) fail(`${def.name}: generics are not supported`);
      if (this.raw.has(def.name)) fail(`${def.name}: defined twice`);
      this.raw.set(def.name, def.type);
    }
  }

  def(name: string): IdlTypeDef {
    const ready = this.done.get(name);
    if (ready !== undefined) return ready;
    const t = this.raw.get(name);
    if (t === undefined) return fail(`type ${name} is not defined`);
    if (this.active.has(name)) fail(`${name}: recursive types are not supported`);
    this.active.add(name);
    let out: IdlTypeDef;
    if (t.kind === 'struct') {
      const fields = this.fields(t.fields, name);
      out = { name, fields, read: (r) => readFields(fields, r) };
    } else if (t.kind === 'enum') {
      if (!Array.isArray(t.variants) || t.variants.length === 0 || t.variants.length > 256) fail(`${name}: an enum needs 1-256 variants`);
      const variants = (t.variants as unknown[]).map((v) => {
        if (!isObject(v) || typeof v.name !== 'string') return fail(`${name}: bad variant`);
        return { name: v.name, fields: v.fields === undefined ? [] : this.fields(v.fields, `${name}.${v.name}`) };
      });
      out = {
        name, fields: [], read: (r) => {
          const i = r.u8();
          const v = variants[i];
          if (v === undefined) throw new DecodeError('E_BAD_VALUE', `${name}: variant ${i} does not exist`);
          return v.fields.length === 0 ? v.name : { variant: v.name, fields: readFields(v.fields, r) };
        },
      };
    } else {
      out = fail(`${name}: kind ${String(t.kind)} is not supported`);
    }
    this.active.delete(name);
    this.done.set(name, out);
    return out;
  }

  /** Named fields `{ name, type }` or tuple fields (a bare type each, named by position). */
  fields(raw: unknown, where: string): FieldPlan[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return fail(`${where}: fields must be a list`);
    return (raw as unknown[]).map((f, i) => (isObject(f) && typeof f.name === 'string' && 'type' in f
      ? { name: f.name, read: this.type(f.type, `${where}.${f.name}`) }
      : { name: String(i), read: this.type(f, `${where}.${i}`) }));
  }

  type(t: unknown, where: string): Plan {
    if (typeof t === 'string') return PRIMITIVES[t] ?? fail(`${where}: type ${t} is not supported`);
    if (!isObject(t)) return fail(`${where}: bad type`);
    const keys = Object.keys(t);
    if (keys.length !== 1) return fail(`${where}: bad type`);
    if ('option' in t) {
      const inner = this.type(t.option, where);
      return (r) => {
        const tag = r.u8();
        if (tag > 1) throw new DecodeError('E_BAD_VALUE', 'an option tag is 0 or 1');
        return tag === 1 ? inner(r) : null;
      };
    }
    if ('vec' in t) {
      const inner = this.type(t.vec, where);
      return (r) => {
        const n = r.u32();
        if (n > MAX_VEC) throw new DecodeError('E_BAD_VALUE', 'vector too long');
        return Array.from({ length: n }, () => inner(r));
      };
    }
    if ('array' in t) {
      const a = t.array;
      if (!Array.isArray(a) || a.length !== 2 || !Number.isSafeInteger(a[1]) || (a[1] as number) < 0 || (a[1] as number) > MAX_VEC) {
        return fail(`${where}: an array needs [type, length]`);
      }
      const inner = this.type(a[0], where);
      const n = a[1] as number;
      return (r) => Array.from({ length: n }, () => inner(r));
    }
    if ('defined' in t) {
      const d = t.defined;
      const name = typeof d === 'string' ? d : isObject(d) && typeof d.name === 'string' && d.generics === undefined ? d.name : fail(`${where}: bad defined type`);
      this.def(name);                                  // compile now, so a missing or bad type fails at load
      return (r) => this.def(name).read(r);
    }
    return fail(`${where}: type ${keys[0] as string} is not supported`);
  }
}

function readFields(fields: readonly FieldPlan[], r: Reader): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.name] = f.read(r);
  return out;
}

function discriminator(v: unknown, where: string): string {
  if (!Array.isArray(v) || v.length !== 8 || !v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return fail(`${where}: a discriminator is 8 bytes`);
  return toHex(Uint8Array.from(v as number[]));
}

export type PinnedIdlSpec = (typeof PINNED_IDLS)[number];

/** Parses and compiles one IDL file's text (after its hash was checked). */
export function compileIdl(text: string, pin: PinnedIdlSpec, sha256: string): Result<PinnedIdl, IdlError> {
  try {
    return { ok: true, value: compileOrThrow(JSON.parse(text), pin, sha256) };
  } catch (e) {
    // Anything that stops the compile fails the load (fail closed), a bug included.
    return { ok: false, error: { code: 'E_IDL_PARSE', file: pin.file, message: e instanceof SyntaxError ? 'not JSON' : (e as Error).message } };
  }
}

function compileOrThrow(doc: unknown, pin: PinnedIdlSpec, sha256: string): PinnedIdl {
  if (!isObject(doc)) return fail('the IDL must be an object');
  if (typeof doc.address !== 'string') return fail('address missing');
  try {
    decodePubkey(doc.address);
  } catch {
    fail('address is not a public key');
  }
  const compiler = new Compiler(doc.types);
  const table = (list: unknown, what: string): Map<string, IdlTypeDef> => {
    if (!Array.isArray(list)) return fail(`${what} must be a list`);
    const byDisc = new Map<string, IdlTypeDef>();
    const names = new Set<string>();
    for (const item of list as unknown[]) {
      if (!isObject(item) || typeof item.name !== 'string') return fail(`${what}: an entry needs a name`);
      const hex = discriminator(item.discriminator, `${what}.${item.name}`);
      if (names.has(item.name)) fail(`${what}.${item.name}: listed twice`);
      if (byDisc.has(hex)) fail(`${what}.${item.name}: discriminator ${hex} is used twice`);
      names.add(item.name);
      byDisc.set(hex, compiler.def(item.name));
    }
    return byDisc;
  };
  const accounts = table(doc.accounts, 'accounts');
  const events = table(doc.events, 'events');
  if (!Array.isArray(doc.instructions)) return fail('instructions must be a list');
  const instructions = new Map<string, IdlInstrDef>();
  const poolQuoteMint = new Map<string, number>();
  for (const ix of doc.instructions as unknown[]) {
    if (!isObject(ix) || typeof ix.name !== 'string' || !Array.isArray(ix.accounts)) return fail('an instruction needs a name and accounts');
    const hex = discriminator(ix.discriminator, `instructions.${ix.name}`);
    if (instructions.has(hex)) fail(`instructions.${ix.name}: discriminator ${hex} is used twice`);
    const accts = (ix.accounts as unknown[]).map((a) => (isObject(a) && typeof a.name === 'string' ? a.name : fail(`instructions.${ix.name}: bad account`)));
    instructions.set(hex, { name: ix.name, accounts: accts, args: compiler.fields(ix.args, `instructions.${ix.name}`) });
    const at = (ix.accounts as Array<Record<string, unknown>>).findIndex((a) => a.name === 'quote_mint'
      && Array.isArray(a.relations) && a.relations.includes('pool'));
    if (at >= 0) poolQuoteMint.set(hex, at);
  }
  const names = (m: Map<string, IdlTypeDef>): Set<string> => new Set([...m.values()].map((d) => d.name));
  for (const a of pin.accounts) if (!names(accounts).has(a)) fail(`account ${a} is missing`);
  for (const e of pin.events) if (!names(events).has(e)) fail(`event ${e} is missing`);
  return { name: pin.name, program: doc.address, file: pin.file, commit: IDL_COMMIT, sha256, accounts, events, instructions, poolQuoteMint };
}

/**
 * Hashes each pinned IDL in `dir`, compares it with the pinned SHA-256 and compiles it. Any failure stops the load:
 * the engine bootstrap (M26) then reports `start_refused` with reason `idl_hash` and exits (ARCH M02, 7.6).
 */
export function verifyPinnedIdls(dir: string, log?: IdlLog, pins: readonly PinnedIdlSpec[] = PINNED_IDLS): Result<PinnedIdl[], IdlError> {
  const out: PinnedIdl[] = [];
  for (const pin of pins) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(`${dir.replace(/\/+$/, '')}/${pin.file}`);
    } catch {
      return { ok: false, error: { code: 'E_IDL_MISSING', file: pin.file } };
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== pin.sha256) {
      log?.event('critical', 'm02.idl_hash_mismatch', { file: pin.file, expected: pin.sha256, actual });
      return { ok: false, error: { code: 'E_IDL_HASH', file: pin.file, expected: pin.sha256, actual } };
    }
    const idl = compileIdl(bytes.toString('utf8'), pin, actual);
    if (!idl.ok) return idl;
    out.push(idl.value);
  }
  for (const idl of out) log?.event('info', 'm02.idl_verified', { program: idl.program, commit: idl.commit, sha256: idl.sha256 });
  return { ok: true, value: out };
}
