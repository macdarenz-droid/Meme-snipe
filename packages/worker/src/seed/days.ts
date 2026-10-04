// SEED-1 source 1: DATA-1's published day releases (`data-day-YYYY-MM-DD`, PR #35). A downloaded release holds
// `units-DAY.tar.part*` (the scanner's finished units, split under the asset limit), `manifest-DAY.json`, the QA and
// parity reports and `SHA256SUMS-DAY`. Every asset is checked against SHA256SUMS-DAY before anything is read, and a
// units part the sums file does not list is refused. From the tar only each unit's `stats.json`, `events.jsonl.zst`
// and (for a unit that crosses the regime boundary) `blocks.csv.zst` are read; the rest is skipped without reading.
//
// Coverage is judged per unit, on the safe side: a unit is covered only when it finished (stats.json present) with no
// decode failure, no missing transaction meta, no unknown pump event and no parent-link break. Anything else, and any
// slot range between units, is a gap. Days on or after the regime boundary (2026-10-02, the pump program upgrade) are
// refused, and a unit that crosses it is cut at the last block before it: those slots come from RPC only.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { SECOND_MS } from '../../../core/src/config/time.ts';

/** First day that is never seeded from published days (supervisor ruling; same constant as DATA-1's publish-day.sh). */
export const REGIME_BOUNDARY_DAY = '2026-10-02';
const BOUNDARY_MS = Date.parse(`${REGIME_BOUNDARY_DAY}T00:00:00Z`);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A create as stored in a unit's events file (scanner field names). */
export interface DayCreate {
  readonly slot: bigint;
  readonly txIdx: number;
  readonly outerIx: number;
  readonly innerIx: number;
  /** Block time in ms. */
  readonly blockTimeMs: number;
  readonly signature: string;
  readonly mint: string;
  readonly creator: string;
  readonly user: string;
  /** Chain timestamp (seconds); the block time when the scanner left it empty. */
  readonly timestamp: bigint;
  readonly tokenTotalSupply: bigint | null;
}

/** A slot range with the block times (ms) of its first and last block, covered or a gap. */
export interface SlotRange {
  readonly fromSlot: bigint;
  readonly toSlot: bigint;
  readonly fromMs: number;
  readonly toMs: number;
  readonly covered: boolean;
  readonly reason?: string;
}

export interface DayRead {
  readonly day: string;
  readonly creates: readonly DayCreate[];
  /** The units of the day, oldest first, each covered or a gap; a unit cut at the regime boundary ends before it. */
  readonly units: readonly SlotRange[];
  /** Assets checked against SHA256SUMS-DAY. */
  readonly verified: number;
}

const sha256File = (path: string): string => {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
};

/** Checks every asset SHA256SUMS-DAY lists; every units part on disk must be listed. Returns the parts in order. */
export const verifyDayRelease = (dir: string, day: string): { readonly parts: readonly string[]; readonly verified: number } => {
  const sums = join(dir, `SHA256SUMS-${day}`);
  if (!existsSync(sums)) throw new RangeError(`${day}: SHA256SUMS-${day} is missing`);
  const listed = new Map<string, string>();
  for (const line of readFileSync(sums, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m === null) continue;
    if (m[2]!.includes('/') || m[2]!.includes('\\') || m[2] === '..') throw new RangeError(`${day}: SHA256SUMS names ${m[2]}, outside the release`);
    listed.set(m[2]!, m[1]!);
  }
  const parts = readdirSync(dir).filter((f) => f.startsWith(`units-${day}.tar.part`)).sort();
  if (parts.length === 0) throw new RangeError(`${day}: no units-${day}.tar.part* asset`);
  for (const p of parts) if (!listed.has(p)) throw new RangeError(`${day}: ${p} is not listed in SHA256SUMS-${day}`);
  for (const f of [`manifest-${day}.json`, `qa-${day}.json`, `parity-${day}.json`]) if (!listed.has(f)) throw new RangeError(`${day}: ${f} is not listed in SHA256SUMS-${day}`);
  for (const [name, want] of listed) {
    const path = join(dir, name);
    if (!existsSync(path)) throw new RangeError(`${day}: ${name} is listed in SHA256SUMS-${day} but missing`);
    const got = sha256File(path);
    if (got !== want) throw new RangeError(`${day}: ${name} has sha256 ${got}, SHA256SUMS-${day} says ${want}`);
  }
  checkReports(dir, day);
  return { parts, verified: listed.size };
};

/**
 * A day is used only when DATA-1's strict QA passed (`qa-DAY.json` `strict.pass`) and the decoder parity found no
 * mismatch and no missing row (`parity-DAY.json`, the same rule as the backtest's `failed()`). Create rows outside a
 * sampled tape have no raw record, so they are scanner-decoded; they are accepted only from days that passed both.
 */
const checkReports = (dir: string, day: string): void => {
  const read = (f: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
      return v as Record<string, unknown>;
    } catch (e) {
      throw new RangeError(`${day}: ${f} cannot be read (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  const qa = read(`qa-${day}.json`)['strict'];
  if (typeof qa !== 'object' || qa === null || (qa as Record<string, unknown>)['pass'] !== true) throw new RangeError(`${day}: the strict QA did not pass`);
  const parity = read(`parity-${day}.json`);
  if (parity['mismatch_count'] !== 0 || parity['missing_row_count'] !== 0) throw new RangeError(`${day}: decoder parity failed (mismatches ${String(parity['mismatch_count'])}, missing rows ${String(parity['missing_row_count'])})`);
};

/** Reads a tar split over several files as one stream: headers are read, unwanted bodies skipped without reading. */
export const tarEntries = function* (paths: readonly string[], want: (name: string) => boolean): Generator<{ readonly name: string; readonly body: Buffer }> {
  const sizes = paths.map((p) => statSync(p).size);
  const total = sizes.reduce((a, b) => a + b, 0);
  const fds = paths.map((p) => openSync(p, 'r'));
  const read = (pos: number, len: number): Buffer => {
    if (pos + len > total) throw new RangeError('tar ends inside an entry');
    const out = Buffer.allocUnsafe(len);
    let done = 0;
    let base = 0;
    for (let i = 0; i < fds.length && done < len; i++) {
      const end = base + sizes[i]!;
      if (pos + done < end) {
        const n = Math.min(len - done, end - (pos + done));
        readSync(fds[i]!, out, done, n, pos + done - base);
        done += n;
      }
      base = end;
    }
    return out;
  };
  const str = (b: Buffer, from: number, len: number): string => {
    const s = b.subarray(from, from + len);
    const z = s.indexOf(0);
    return (z < 0 ? s : s.subarray(0, z)).toString('utf8');
  };
  try {
    let pos = 0;
    let longName: string | null = null;
    while (pos + 512 <= total) {
      const h = read(pos, 512);
      if (h.every((b) => b === 0)) break;
      const size = Number.parseInt(str(h, 124, 12).trim() || '0', 8);
      if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`tar header at ${pos} has a bad size`);
      const type = String.fromCharCode(h[156]!);
      const prefix = str(h, 257, 6).startsWith('ustar') ? str(h, 345, 155) : '';
      let name = longName ?? (prefix === '' ? str(h, 0, 100) : `${prefix}/${str(h, 0, 100)}`);
      longName = null;
      const body = pos + 512;
      if (type === 'L') longName = str(read(body, size), 0, size);
      else if (type === 'x') {
        const m = /\d+ path=([^\n]+)\n/.exec(read(body, size).toString('utf8'));
        if (m !== null) longName = m[1]!;
      } else if ((type === '0' || type === '\0') && want((name = name.replace(/^\.\//, '')))) yield { name, body: read(body, size) };
      pos = body + Math.ceil(size / 512) * 512;
    }
  } finally {
    for (const fd of fds) closeSync(fd);
  }
};

interface UnitStats {
  readonly from_slot: number;
  readonly to_slot: number;
  readonly first_block_time: number;
  readonly last_block_time: number;
  readonly decode_failures?: number;
  readonly missing_meta?: number;
  readonly unknown_events?: Readonly<Record<string, number>> | null;
  readonly chain_breaks?: readonly string[] | null;
}

const UNIT_FILE = /^units\/(\d+)\/(\d+)-(\d+)\/(stats\.json|events\.jsonl\.zst|blocks\.csv\.zst)$/;

/** Why a finished unit cannot vouch for every create in it, or null when it can. */
const unitDefect = (s: UnitStats): string | null => {
  if ((s.decode_failures ?? 0) > 0) return `${s.decode_failures} decode failures`;
  if ((s.missing_meta ?? 0) > 0) return `${s.missing_meta} transactions without meta`;
  const unknownPump = Object.keys(s.unknown_events ?? {}).filter((k) => k.includes('pump') && !k.includes('amm'));
  if (unknownPump.length > 0) return `unknown pump events (${unknownPump[0]})`;
  if ((s.chain_breaks ?? []).length > 0) return 'parent-link breaks';
  return null;
};

/** The last block (slot, ms) before `limitMs` in a unit's blocks CSV (numeric columns only, never quoted). */
const lastBlockBefore = (csv: string, limitMs: number, unit: string): { readonly slot: bigint; readonly ms: number } | null => {
  const lines = csv.split('\n').filter((l) => l.trim() !== '');
  const head = (lines[0] ?? '').split(',');
  const si = head.indexOf('slot');
  const ti = head.indexOf('block_time');
  if (si < 0 || ti < 0) throw new RangeError(`unit ${unit}: blocks.csv.zst has no slot or block_time column`);
  let last: { slot: bigint; ms: number } | null = null;
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const ms = Number(f[ti]) * SECOND_MS;
    if (!/^\d+$/.test(f[si] ?? '') || !Number.isSafeInteger(ms)) throw new RangeError(`unit ${unit}: bad block row ${line}`);
    const slot = BigInt(f[si]!);
    if (ms < limitMs && (last === null || slot > last.slot)) last = { slot, ms };
  }
  return last;
};

const big = (v: unknown): bigint | null => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null);

/**
 * Reads one verified day release in `dir`: its creates and per-unit coverage, before the regime boundary only.
 * Throws on a day on or after the boundary, a failed checksum, an unlisted part or an unreadable unit.
 */
export const readDayRelease = (dir: string, day: string): DayRead => {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new RangeError(`bad day ${day}`);
  if (day >= REGIME_BOUNDARY_DAY) throw new RangeError(`${day} is on or after the regime boundary ${REGIME_BOUNDARY_DAY}: seeded from RPC only`);
  const { parts, verified } = verifyDayRelease(dir, day);
  const units = new Map<string, { stats?: UnitStats; events?: Buffer; blocks?: Buffer }>();
  for (const { name, body } of tarEntries(parts.map((p) => join(dir, p)), (n) => UNIT_FILE.test(n.replace(/^\.\//, '')))) {
    const m = UNIT_FILE.exec(name)!;
    const key = `${m[1]}/${m[2]}-${m[3]}`;
    const u = units.get(key) ?? {};
    if (m[4] === 'stats.json') u.stats = JSON.parse(body.toString('utf8')) as UnitStats;
    else if (m[4] === 'events.jsonl.zst') u.events = body;
    else u.blocks = body;
    units.set(key, u);
  }
  const ranges: SlotRange[] = [];
  const creates: DayCreate[] = [];
  for (const [key, u] of units) {
    const [, from, to] = /\/(\d+)-(\d+)$/.exec(key)!;
    // An unfinished unit (no stats.json) is a gap over its whole range.
    if (u.stats === undefined) {
      ranges.push({ fromSlot: BigInt(from!), toSlot: BigInt(to!), fromMs: Number.NaN, toMs: Number.NaN, covered: false, reason: `unit ${key} unfinished` });
      continue;
    }
    const s = u.stats;
    let toSlot = BigInt(s.to_slot);
    let toMs = s.last_block_time * SECOND_MS;
    const fromMs = s.first_block_time * SECOND_MS;
    if (fromMs >= BOUNDARY_MS) continue; // wholly after the boundary: RPC's range
    if (toMs >= BOUNDARY_MS) {
      // Cut at the last block before the boundary, from the unit's own block rows.
      if (u.blocks === undefined) throw new RangeError(`unit ${key} crosses ${REGIME_BOUNDARY_DAY} and has no blocks.csv.zst`);
      const l = lastBlockBefore(zstdDecompressSync(u.blocks).toString('utf8'), BOUNDARY_MS, key);
      if (l === null) continue;
      toSlot = l.slot;
      toMs = l.ms;
    }
    const defect = u.events === undefined ? 'no events file' : unitDefect(s);
    ranges.push({ fromSlot: BigInt(s.from_slot), toSlot, fromMs, toMs, covered: defect === null, ...(defect === null ? {} : { reason: `unit ${key}: ${defect}` }) });
    if (u.events === undefined) continue;
    for (const line of zstdDecompressSync(u.events).toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o['event'] !== 'CreateEvent' || o['program'] !== 'pump') continue;
      const slot = BigInt(String(o['slot']));
      const blockTimeMs = Number(o['block_time']) * SECOND_MS;
      if (slot > toSlot || blockTimeMs >= BOUNDARY_MS) continue;
      const f = (o['fields'] ?? {}) as Record<string, unknown>;
      const ts = big(f['timestamp']) ?? BigInt(Number(o['block_time']));
      if (typeof f['mint'] !== 'string' || typeof f['creator'] !== 'string') throw new RangeError(`unit ${key}: a CreateEvent at slot ${slot} has no mint or creator`);
      creates.push({
        slot, txIdx: Number(o['tx_idx']), outerIx: Number(o['outer_ix'] ?? 0), innerIx: Number(o['inner_ix'] ?? 0), blockTimeMs,
        signature: String(o['signature']), mint: f['mint'], creator: f['creator'], user: typeof f['user'] === 'string' ? f['user'] : f['creator'],
        timestamp: ts, tokenTotalSupply: big(f['token_total_supply']),
      });
    }
  }
  ranges.sort((a, b) => (a.fromSlot < b.fromSlot ? -1 : a.fromSlot > b.fromSlot ? 1 : 0));
  return { day, creates, units: ranges, verified };
};
