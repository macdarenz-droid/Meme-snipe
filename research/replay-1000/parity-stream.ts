// REPLAY-1000: TEST-1's parity check (packages/worker/src/run/parity.ts) for recordings too large to hold in memory.
// The same steps, streamed: the recorder's frames are read in their seq order and turned into events with the same
// functions (`rankIn`, `eventsOfFrame`), the release sequence is fed to core's Engine with the same strategy and store
// rules as `replayBoot`, and each record becomes the line the desk would write (`journalFields`, `jsonText`,
// `redact`). Every replay's lines are compared with the run's journal (normalised as `normalise` does) one by one,
// and replays are compared with each other by a running sha256. A first-start boot only (no saved state to restore).
//   node research/replay-1000/parity-stream.ts <state-dir> <replays> [mode A|B]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, TRIAL_POLICY, startSession, type PolicySession } from '../../packages/core/src/config/index.ts';
import { Engine, GENESIS, type Feed, type FeedEvent, type LogRecord } from '../../packages/core/src/engine/index.ts';
import { deepFreeze } from '../../packages/core/src/engine/freeze.ts';
import { LiveStrategy, SEED_KEY } from '../../packages/worker/src/engine/strategy.ts';
import { eventsOfFrame, rankIn, SigRanks, type Frame, type Release } from '../../packages/worker/src/providers/canonical.ts';
import { ReleaseClock } from '../../packages/worker/src/providers/live-feed.ts';
import { journalFields } from '../../packages/worker/src/run/desk.ts';
import { engineFeed } from '../../packages/worker/src/run/engine-feed.ts';
import { jsonText, parseTyped } from '../../packages/worker/src/run/json.ts';
import { NOT_REPLAYED, normalise } from '../../packages/worker/src/run/parity.ts';
import { redact } from '../../packages/worker/src/run/redact.ts';
import { PAPER_SCENARIO, strategyConfig } from '../../packages/worker/src/run/settings.ts';
import { liveCollapse, liveForget, liveRetention, liveShape } from '../../packages/worker/src/run/store-rules.ts';
import { modeBSession } from './run.ts';

/** The lines of a recorder file series (frames-NNN or releases-NNN), in file order, one at a time. */
function* fileLines(dir: string, prefix: string): Generator<string> {
  const days = join(dir, 'days');
  for (const day of readdirSync(days).sort()) {
    for (const f of readdirSync(join(days, day)).filter((x) => x.startsWith(prefix)).sort()) {
      const p = join(days, day, f);
      const text = f.endsWith('.zst') ? zstdDecompressSync(readFileSync(p)).toString('utf8') : readFileSync(p, 'utf8');
      const lines = text.split('\n');
      if (!f.endsWith('.zst') && !text.endsWith('\n')) lines.pop();
      for (const l of lines) if (l !== '') yield l;
    }
  }
}

/** The release sequence as a Feed, reading frames only as far as each release needs (replayRecorded, streamed). */
const streamFeed = (recDir: string): { feed: Feed; clock: ReleaseClock; seed: Frame | null } => {
  const frames = fileLines(recDir, 'frames-');
  const releases = fileLines(recDir, 'releases-');
  const ranks = new Map<bigint, SigRanks>();
  const pending = new Map<string, { event: FeedEvent; frameSeq: number }>();
  let readSeq = -1;
  let seed: Frame | null = null;
  let nextIndex = 0;
  const clock = new ReleaseClock(GENESIS);
  const readFrame = (): boolean => {
    const n = frames.next();
    if (n.done === true) return false;
    const f = parseTyped(n.value) as Frame;
    if (f.seq <= readSeq) throw new RangeError(`frame ${f.seq} out of order`);
    readSeq = f.seq;
    if (f.body.type === 'fact' && f.body.key === SEED_KEY) seed = f;
    if (f.duplicate) return true;
    let r = ranks.get(f.place.slot);
    if (r === undefined) ranks.set(f.place.slot, (r = new SigRanks()));
    rankIn(r, f);
    for (const e of eventsOfFrame(f, r)) pending.set(e.id, { event: deepFreeze(e), frameSeq: f.seq });
    return true;
  };
  const feed: Feed = {
    next: () => {
      const n = releases.next();
      if (n.done === true) return null;
      const rel = JSON.parse(n.value) as Release;
      if (rel.index !== nextIndex) throw new RangeError(`release ${nextIndex} is missing`);
      nextIndex++;
      while (readSeq < rel.frameSeq) if (!readFrame()) break;
      const hit = pending.get(rel.eventId);
      if (hit === undefined || hit.frameSeq !== rel.frameSeq) throw new RangeError(`release ${rel.index}: event ${rel.eventId} is not in frame ${rel.frameSeq}`);
      pending.delete(rel.eventId);
      clock.cover(hit.event.moment);
      return hit.event;
    },
  };
  // The seed frame comes first in every recording (the worker ingests it before any release).
  while (seed === null && readFrame()) if (readSeq > 50) break;
  return { feed, clock, seed };
};

export const streamParity = (stateDir: string, replays: number, session: PolicySession) => {
  const recRoot = join(stateDir, 'recorder');
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
  const start = journal.map((l) => JSON.parse(l) as { kind: string; boot: string; seed?: string }).find((j) => j.kind === 'start')!;
  const live = journal.filter((l) => {
    const r = JSON.parse(l) as { kind: string; boot: string; action?: string };
    return r.kind === 'decision' && r.boot === start.boot && !(r.action !== undefined && NOT_REPLAYED.includes(r.action));
  }).map(normalise);
  // The run's own strategy inputs (run.ts strategy.json); older runs: the host config's shakedown block.
  const used = join(stateDir, '..', 'strategy.json');
  const shakedown = (JSON.parse(readFileSync(new URL('../../ops/host-config.json', import.meta.url), 'utf8')) as { shakedown: Record<string, string> }).shakedown;
  const inputs = existsSync(used)
    ? (JSON.parse(readFileSync(used, 'utf8')) as { paperEdgePpm: string; salt: string; s0Diagnostic: boolean })
    : { paperEdgePpm: shakedown['ZEROED_PAPER_EDGE_PPM'] ?? '0', salt: shakedown['ZEROED_RUN_ID'] ?? 'S0', s0Diagnostic: shakedown['ZEROED_S0_DIAGNOSTIC'] === 'on' };
  const config = strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG, BigInt(inputs.paperEdgePpm), { timing: 'random', salt: inputs.salt, s0Diagnostic: inputs.s0Diagnostic });
  void PAPER_SCENARIO;
  const out: { replay: number; lines: number; sha256: string; divergence: { index: number; live: string | null; replay: string | null } | null }[] = [];
  for (let k = 0; k < replays; k++) {
    const { feed, clock, seed } = streamFeed(join(recRoot, start.boot));
    const st = seed !== null && (seed as Frame).body.type === 'fact' ? ((seed as Frame).body as { value?: { state?: { ref?: unknown } } }).value?.state?.ref : undefined;
    if (st !== undefined && st !== null) throw new Error('this boot restored saved state: use parity.ts');
    const strategy = new LiveStrategy({ session, rugs: RUG_CONFIG, config });
    // Records are compared as they come (before each next event), then dropped, as the worker drops consumed ones.
    let take: () => void = () => undefined;
    const inner = engineFeed(feed, session.policy).feed;
    const wrapped: Feed = { next: () => { take(); return inner.next(); }, ...(inner.retire === undefined ? {} : { retire: (ids: readonly string[]) => inner.retire!(ids) }) };
    const engine = new Engine({ clock, feed: wrapped, strategy, runner: { run: () => undefined }, seed: start.seed!, book: { maxOpenPositions: session.policy.positions.maxOpen }, retention: liveRetention, collapse: liveCollapse, shape: liveShape, forget: liveForget });
    const h = createHash('sha256');
    let i = 0;
    let divergence: (typeof out)[number]['divergence'] = null;
    const records = engine.records as LogRecord[];
    let taken = 0;
    take = (): void => {
      for (; taken < records.length; taken++) {
        const f = journalFields(records[taken]!);
        if (f === null) continue;
        const line = redact(jsonText({ kind: 'decision', ...f }));
        h.update(line).update('\n');
        if (divergence === null && line !== (live[i] ?? null)) divergence = { index: i, live: live[i] ?? null, replay: line };
        i++;
      }
      // Bounded memory: records already compared are dropped.
      records.splice(0, taken);
      taken = 0;
    };
    engine.drain();
    take();
    if (divergence === null && i !== live.length) divergence = { index: i, live: live[i] ?? null, replay: null };
    out.push({ replay: k, lines: i, sha256: h.digest('hex'), divergence });
  }
  const deterministic = out.every((r) => r.sha256 === out[0]!.sha256);
  return { boot: start.boot, liveLines: live.length, replays: out, deterministic, ok: deterministic && out.every((r) => r.divergence === null) };
};

const main = () => {
  const [dir, n, mode] = process.argv.slice(2);
  const r = streamParity(dir!, Number(n ?? '10'), mode === 'B' ? modeBSession() : startSession(TRIAL_POLICY));
  console.log(JSON.stringify(r, null, 1).slice(0, 4000));
  process.exit(r.ok ? 0 : 1);
};

if (process.argv[1] === new URL(import.meta.url).pathname) main();
