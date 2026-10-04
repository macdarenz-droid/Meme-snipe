// TEST-1: live/replay parity for a recorded worker session (docs/ARCHITECTURE.md §16.1, Wave E). Each boot's recorded
// frames are replayed in their recorded release order through the backtest's engine path (core's Engine on
// `replayRecorded`, core's FactFeed, the same strategy), and every engine record is turned into the journal line the
// live desk writes (`journalFields`). The replay's lines must equal the live journal's `decision` lines byte for byte
// once the wall-clock fields (seq, ts, boot) are dropped, in every one of N replays. The first differing line is
// reported with its event. The session's ledger is replayed too, by the check the caller hands in (core's
// `replayLedgerFile`: worker source never reaches ledger internals, packages/core/test/ledger/guard.ts).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type { PolicySession, RugConfig } from '../../../core/src/config/index.ts';
import { Engine, type LogRecord } from '../../../core/src/engine/index.ts';
import { Ledger } from '../../../core/src/ledger/index.ts';
import { STATE_FILES } from '../../../runner/src/contract.ts';
import { LiveStrategy, SEED_KEY, type SavedStateRef, type StrategyConfig, type StrategyDeps } from '../engine/strategy.ts';
import { PERSIST_FILE, fileSha256, loadState } from '../persist/index.ts';
import { replayRecorded, type Frame, type Release } from '../providers/index.ts';
import { journalFields } from './desk.ts';
import { engineFeed } from './engine-feed.ts';
import { jsonText, parseTyped } from './json.ts';
import { redact } from './redact.ts';

/**
 * Journal `decision` lines that no engine record makes, so a replay cannot rebuild them: refused API commands and
 * ledger refusals (a ledger write failing after the engine applied the event). Counted in the report, never compared;
 * a ledger refusal fails the session (it is a live divergence), a refused command does not.
 */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const NOT_REPLAYED: readonly string[] = ['command_refused', 'ledger_refused'];

/** A journal line without its wall-clock fields: `{"kind":...}` exactly as the replay writes it. */
export const normalise = (line: string): string => line.replace(/^\{"seq":\d+,"ts":"[^"]*","boot":"[^"]*",/, '{');

/** The line the desk would journal for one replayed record, in the same encoding (jsonText, redact). */
const replayLine = (r: LogRecord): string | null => {
  const f = journalFields(r);
  return f === null ? null : redact(jsonText({ kind: 'decision', ...f }));
};

/** The parity replay cannot restore the saved state a boot's seed names (WORKER-GROW): it refuses, with no decisions. */
export class SavedStateMissing extends Error {}

/**
 * The saved state a boot's seed names, read from the copy in its recording and checked against the sha256 the seed
 * carries, before anything is replayed. A copy that is missing, unreadable, refused or of another hash fails the replay
 * loudly (`SavedStateMissing`); it never falls back to an empty or other state.
 */
export const savedStateOf = (b: Pick<BootInput, 'frames' | 'savedState'> & { readonly boot?: string }, d: ParityDeps): Pick<StrategyDeps, 'savedState'> => {
  const seed = b.frames.find((f) => f.body.type === 'fact' && f.body.key === SEED_KEY);
  const st = seed !== undefined && seed.body.type === 'fact' && isObj(seed.body.value) ? seed.body.value['state'] : undefined;
  const ref = isObj(st) && isObj(st['ref']) ? st['ref'] as unknown as SavedStateRef : null;
  if (ref === null) return {};
  const path = b.savedState;
  const fail = (why: string): never => {
    throw new SavedStateMissing(`boot ${b.boot ?? '?'}: the seed names saved state ${ref.file} (sha256 ${ref.sha256}), ${why}; nothing is replayed`);
  };
  if (path === null || path === undefined || !existsSync(path)) return fail('and the recording has no copy of it');
  // G4c: a packed copy is read through a plain temporary file; the hash is that of the plain bytes, as the seed's.
  let plain = path;
  let sha: string;
  let tmp: string | null = null;
  try {
    if (path.endsWith('.zst')) {
      tmp = mkdtempSync(join(tmpdir(), 'zeroed-saved-'));
      plain = join(tmp, PERSIST_FILE);
      writeFileSync(plain, zstdDecompressSync(readFileSync(path)));
    }
    sha = fileSha256(plain);
  } catch (e) {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    return fail(`and its copy is unreadable (${e instanceof Error ? e.message : 'error'})`);
  }
  if (sha !== ref.sha256) {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    return fail(`and the recording's copy has sha256 ${sha}`);
  }
  const restored = loadState(plain, d.rugs);
  if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  if (!restored.ok) return fail(`and its copy is refused (${restored.reason})`);
  if (restored.version !== ref.version) return fail(`and its copy is format version ${restored.version}, not ${ref.version}`);
  let given = false;
  return {
    savedState: (r) => {
      if (given || r.sha256 !== ref.sha256 || r.file !== ref.file || r.version !== ref.version) throw new SavedStateMissing(`boot ${b.boot ?? '?'}: a second or different saved state asked for`);
      given = true;
      return { index: restored.index, labeller: restored.labeller };
    },
  };
};

export interface BootInput {
  readonly boot: string;
  /** The copy of the saved state the boot restored from (`<recording>/deployer-state.json`), or null when there is none. */
  readonly savedState?: string | null;
  /** Why this boot cannot be replayed at all (it has decisions but no recording or no seed), or null. */
  readonly missing: 'no recording' | 'no seed' | null;
  readonly seed: string;
  readonly frames: readonly Frame[];
  readonly releases: readonly Release[];
  /** The live journal's decision lines of this boot, normalised, the ones a replay can rebuild. */
  readonly live: readonly string[];
  /** Decision lines left out of the comparison (NOT_REPLAYED), by action. */
  readonly excluded: Readonly<Record<string, number>>;
  /** Values the recorder redacted from this boot's files (its manifest's gaps): a replay differs where they were. */
  readonly redactions: number;
}

export interface Divergence {
  /** Position in the boot's compared decision lines (0-based). */
  readonly index: number;
  /** The event the line is about, from whichever side has the line. */
  readonly event: string | null;
  readonly live: string | null;
  readonly replay: string | null;
}

export interface BootReport {
  readonly boot: string;
  readonly missing: 'no recording' | 'no seed' | null;
  readonly decisions: number;
  readonly replays: number;
  /** Every replay gave the same lines. */
  readonly deterministic: boolean;
  /** The first line where the replay differs from live, or null. */
  readonly divergence: Divergence | null;
  readonly excluded: Readonly<Record<string, number>>;
  readonly redactions: number;
}

/** A ledger replay's verdict (core's `ReplayReport`): passes when `ok`. */
export interface LedgerVerdict {
  readonly ok: boolean;
}

export interface ParityReport<L extends LedgerVerdict = LedgerVerdict> {
  readonly ok: boolean;
  readonly boots: readonly BootReport[];
  /** The ledger replay's report, or null when the folder has no ledger. */
  readonly ledger: L | null;
}

export interface ParityDeps {
  readonly session: PolicySession;
  readonly rugs: RugConfig;
  readonly strategy: StrategyConfig;
}

/** Replays one boot's recording once and returns the journal lines the desk would have written. */
export const replayBoot = (b: Pick<BootInput, 'seed' | 'frames' | 'releases' | 'savedState'> & { readonly boot?: string }, d: ParityDeps): string[] => {
  const { clock, feed } = replayRecorded(b.frames, b.releases);
  const strategy = new LiveStrategy({ session: d.session, rugs: d.rugs, config: d.strategy, ...savedStateOf(b, d) });
  const engine = new Engine({ clock, feed: engineFeed(feed, d.session.policy).feed, strategy, runner: { run: () => undefined }, seed: b.seed, book: { maxOpenPositions: d.session.policy.positions.maxOpen } });
  engine.drain();
  return (engine.records as readonly LogRecord[]).flatMap((r) => {
    const line = replayLine(r);
    return line === null ? [] : [line];
  });
};

const eventOf = (line: string | null): string | null => {
  if (line === null) return null;
  const m = /"event":"((?:[^"\\]|\\.)*)"/.exec(line);
  return m === null ? null : m[1]!;
};

/** The first index where the two line lists differ, or null when they are equal. */
export const firstDivergence = (live: readonly string[], replay: readonly string[]): Divergence | null => {
  const n = Math.max(live.length, replay.length);
  for (let i = 0; i < n; i++) {
    const a = live[i] ?? null;
    const b = replay[i] ?? null;
    if (a !== b) return { index: i, event: eventOf(a) ?? eventOf(b), live: a, replay: b };
  }
  return null;
};

/** Replays a boot `replays` times; it passes when every replay is identical to the first and to live. */
export const checkBoot = (b: BootInput, d: ParityDeps, replays: number, replay: typeof replayBoot = replayBoot): BootReport => {
  if (b.missing !== null) {
    // Nothing was replayed: no replay disagreed (vacuously deterministic), and `missing` alone fails the session.
    return { boot: b.boot, missing: b.missing, decisions: b.live.length, replays: 0, deterministic: true, divergence: null, excluded: b.excluded, redactions: b.redactions };
  }
  const first = replay(b, d);
  let deterministic = true;
  for (let k = 1; k < replays; k++) if (firstDivergence(first, replay(b, d)) !== null) deterministic = false;
  return { boot: b.boot, missing: null, decisions: b.live.length, replays, deterministic, divergence: firstDivergence(b.live, first), excluded: b.excluded, redactions: b.redactions };
};

const rows = <T>(dir: string, re: RegExp, parse: (l: string) => T): T[] => {
  const days = join(dir, 'days');
  if (!existsSync(days)) return [];
  return readdirSync(days).sort().flatMap((day) => readdirSync(join(days, day)).filter((f) => re.test(f)).sort().flatMap((f) => {
    const p = join(days, day, f);
    const text = f.endsWith('.zst') ? zstdDecompressSync(readFileSync(p)).toString('utf8') : readFileSync(p, 'utf8');
    // A file a killed process left open may end in a torn line: only whole lines are read.
    const lines = text.split('\n');
    if (!f.endsWith('.zst') && !text.endsWith('\n')) lines.pop();
    return lines.filter((l) => l !== '').map(parse);
  }));
};

/** Values the recorder redacted in one boot's sealed files, from its manifest (0 without a manifest). */
const redactionsOf = (dir: string): number => {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return 0;
  const m = JSON.parse(readFileSync(path, 'utf8')) as { coverage_gaps?: { redactions?: unknown }[] };
  return (m.coverage_gaps ?? []).reduce((n, g) => n + (typeof g.redactions === 'number' ? g.redactions : 0), 0);
};

/** Every boot of a worker state folder: its recording, seed and live decision lines. */
export const loadSession = (stateDir: string): BootInput[] => {
  const journal = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8').split('\n').filter((l) => l !== '');
  const recRoot = join(stateDir, STATE_FILES.recorder);
  const out: BootInput[] = [];
  for (const line of journal) {
    const j = JSON.parse(line) as { kind: string; boot: string; seed?: string };
    if (j.kind !== 'start') continue;
    const dir = join(recRoot, j.boot);
    const live: string[] = [];
    const excluded: Record<string, number> = {};
    for (const l of journal) {
      const r = JSON.parse(l) as { kind: string; boot: string; action?: string };
      if (r.kind !== 'decision' || r.boot !== j.boot) continue;
      if (r.action !== undefined && NOT_REPLAYED.includes(r.action)) excluded[r.action] = (excluded[r.action] ?? 0) + 1;
      else live.push(normalise(l));
    }
    // A boot that decided nothing (a reconcile-only run) has nothing to compare; one that did must be replayable.
    if (live.length === 0 && Object.keys(excluded).length === 0) continue;
    const missing = j.seed === undefined ? 'no seed' : !existsSync(dir) ? 'no recording' : null;
    out.push({
      boot: j.boot, missing, seed: j.seed ?? '', live, excluded, redactions: missing === 'no recording' ? 0 : redactionsOf(dir),
      savedState: existsSync(join(dir, PERSIST_FILE)) ? join(dir, PERSIST_FILE) : existsSync(join(dir, `${PERSIST_FILE}.zst`)) ? join(dir, `${PERSIST_FILE}.zst`) : null,
      frames: rows(dir, /^frames-.*\.jsonl(\.zst)?$/, (l) => parseTyped(l) as Frame),
      releases: rows(dir, /^releases-.*\.jsonl(\.zst)?$/, (l) => JSON.parse(l) as Release),
    });
  }
  return out;
};

/** TEST-1's check of a whole session: every recorded boot replayed `replays` times, and the ledger replayed by `ledgerCheck`. */
export const checkSession = <L extends LedgerVerdict>(stateDir: string, d: ParityDeps, ledgerCheck: (path: string) => L, replays = 10): ParityReport<L> => {
  const boots = loadSession(stateDir).map((b) => checkBoot(b, d, replays));
  const ledgerPath = join(stateDir, Ledger.FILE);
  const ledger = existsSync(ledgerPath) ? ledgerCheck(ledgerPath) : null;
  // Parity evidence only from unaltered, complete inputs: every deciding boot replayable, nothing redacted, and no
  // ledger refusal (a live engine/ledger divergence) in the journal.
  const ok = boots.length > 0 && ledger !== null && ledger.ok
    && boots.every((b) => b.missing === null && b.deterministic && b.divergence === null && b.redactions === 0 && (b.excluded['ledger_refused'] ?? 0) === 0);
  return { ok, boots, ledger };
};
