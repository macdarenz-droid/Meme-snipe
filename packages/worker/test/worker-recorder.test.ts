// The market recorder (§12.4, WORKER-1): every raw live input from process start, in DATA-1's dataset layout (schema 2),
// sealed with a manifest DATA-1's QA reads; a kill leaves nothing it cannot seal at the next start; and the recorded
// frames with their release order, replayed through the same engine and strategy, reproduce the live decisions.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { recordFromRpc, type RpcTransactionBase64 } from '../../core/src/chain/index.ts';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { Engine, type LogRecord } from '../../core/src/engine/index.ts';
import { GATE_REASONS_PREFIX, LiveStrategy } from '../src/engine/strategy.ts';
import { replayRecorded, type Frame, type Release } from '../src/providers/index.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { parseTyped } from '../src/run/json.ts';
import { Market, makeWorker, passingMarket } from './worker-harness.ts';

/** Test-only (POS-1): these tests move a held position's price by re-publishing the pool fact. */
const HELD = { heldPoolFacts: true } as const;

const ROOT = join(import.meta.dirname, '..', '..', '..');
const files = (dir: string, re: RegExp): string[] =>
  readdirSync(join(dir, 'days')).sort().flatMap((d) => readdirSync(join(dir, 'days', d)).filter((f) => re.test(f)).sort().map((f) => join(dir, 'days', d, f)));
const rows = <T>(paths: readonly string[], parse: (l: string) => T): T[] =>
  paths.flatMap((p) => zstdDecompressSync(readFileSync(p)).toString('utf8').split('\n').filter((l) => l !== '').map(parse));

interface Case { readonly transactions: readonly (RpcTransactionBase64 & { readonly signature: string })[] }
const TX = (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rug-replay.json'), 'utf8')) as { cases: Case[] }).cases[0]!.transactions[0]!;

describe('the market recorder', () => {
  it('writes DATA-1\'s layout from the first minute, sealed with a schema-2 manifest that DATA-1\'s QA reads', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    // One fetched transaction: a schema-2 raw record (DEC-1's shape).
    h.worker.feed.ingest('helius', { type: 'tx', record: recordFromRpc(TX.signature, TX, null) }, { receivedAt: h.timers.now(), lookup: true });
    await m.run(2_000, 200, () => m.pool());
    await h.worker.stop();

    const recRoot = join(h.stateDir, 'recorder');
    const [boot] = readdirSync(recRoot);
    expect(boot).toBe(h.worker.boot);
    const dir = join(recRoot, boot!);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { schema: number; source: string; days: { files: { path: string; sha256: string }[] }[] };
    expect(manifest).toMatchObject({ schema: 2, source: 'live-recorder' });
    const listed = manifest.days.flatMap((d) => d.files.map((f) => f.path));
    expect(listed.some((p) => /frames-\d{3}\.jsonl\.zst$/.test(p))).toBe(true);
    expect(listed.some((p) => /raw-\d{3}\.jsonl\.zst$/.test(p))).toBe(true);
    expect(listed.some((p) => /releases-\d{3}\.jsonl\.zst$/.test(p))).toBe(true);
    // Nothing left unsealed after a clean stop.
    expect(files(dir, /\.jsonl$/)).toEqual([]);
    // Every frame from process start: the first one recorded is the first one the feed took (seq 0).
    const frames = rows(files(dir, /^frames-/), (l) => parseTyped(l) as Frame);
    expect(frames[0]!.seq).toBe(0);
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, k) => k));
    expect(frames.some((f) => f.body.type === 'slot')).toBe(true);

    const qa = spawnSync(process.execPath, ['research/historical/qa/check.mjs', dir], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(qa.status, qa.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, 'qa', 'report.json'), 'utf8')) as { raw: { records: number; signature_mismatch: number } };
    expect(report.raw).toMatchObject({ records: 1, signature_mismatch: 0 });
  });

  it('a kill leaves plain files that the next start cuts at the last whole line and seals', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(1_000, 200, () => m.pool());
    const dir = join(h.stateDir, 'recorder', h.worker.boot);
    await h.worker.kill();
    expect(files(dir, /\.jsonl$/).length).toBeGreaterThan(0);
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(files(dir, /\.jsonl$/)).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { coverage_gaps: { reason?: string }[]; units: { frames: number }[] };
    expect(manifest.coverage_gaps.some((g) => /without a clean stop/.test(g.reason ?? ''))).toBe(true);
    expect(manifest.units[0]!.frames).toBe(rows(files(dir, /^frames-/), (l) => l).length);
    expect(h2.logs.some((l) => l.includes(`sealed files of boot ${h.worker.boot}`))).toBe(true);
    await h2.worker.stop();
  });

  it('replaying the recorded frames in their release order through the same engine and strategy reproduces the live decisions', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    await m.run(6_000, 400, () => {
      m.slot();
      m.pool(700_000n);
    });
    await h.worker.stop();
    const live = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['kind'] === 'decision' && typeof l['result'] === 'string')
      .map((l) => ({ event: l['event'], reasons: l['reasons'], result: l['result'] }));
    expect(live.some((d) => (d.reasons as string[])[0] === 'enter')).toBe(true);
    expect(live.some((d) => (d.reasons as string[])[0] === 'exit')).toBe(true);

    const dir = join(h.stateDir, 'recorder', h.worker.boot);
    const frames = rows(files(dir, /^frames-/), (l) => parseTyped(l) as Frame);
    const releases = rows(files(dir, /^releases-/), (l) => JSON.parse(l) as Release);
    const start = JSON.parse(readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').split('\n')[0]!) as { seed: string };
    const { clock, feed } = replayRecorded(frames, releases);
    const strategy = new LiveStrategy({ session: h.session, rugs: RUG_CONFIG, config: h.worker.strategyConfig });
    // World reports are recorded frames, so the replay needs no outside world: effects go nowhere.
    const engine = new Engine({ clock, feed: engineFeed(feed, h.session.policy).feed, strategy, runner: { run: () => undefined }, seed: start.seed, book: { maxOpenPositions: h.session.policy.positions.maxOpen } });
    engine.drain();
    const replayed = (engine.records as readonly LogRecord[]).flatMap((r) => (r.type === 'decision' ? [{ event: r.eventId, reasons: r.reasons.filter((x) => !x.startsWith(GATE_REASONS_PREFIX)), result: r.result }] : []));
    expect(replayed).toEqual(live);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
  });

  it('across a restart: boot 2\'s recorded frames (the restored book and exit plans among them) replay to its own decisions', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    expect(Object.values(h.worker.book.positions).some((p) => p.status === 'open')).toBe(true);
    await h.worker.kill();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    await m2.run(8_000, 400, () => {
      m2.slot();
      m2.pool(700_000n);
    });
    await h2.worker.stop();
    const live = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision' && typeof l['result'] === 'string')
      .map((l) => ({ event: l['event'], reasons: l['reasons'], result: l['result'] }));
    expect(live.some((d) => (d.reasons as string[])[0] === 'restore')).toBe(true);
    expect(live.some((d) => (d.reasons as string[])[0] === 'exit')).toBe(true);

    const dir = join(h.stateDir, 'recorder', h2.worker.boot);
    const frames = rows(files(dir, /^frames-/), (l) => parseTyped(l) as Frame);
    const releases = rows(files(dir, /^releases-/), (l) => JSON.parse(l) as Release);
    const start = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; boot: string; seed: string })
      .find((l) => l.kind === 'start' && l.boot === h2.worker.boot)!;
    const { clock, feed } = replayRecorded(frames, releases);
    const strategy = new LiveStrategy({ session: h2.session, rugs: RUG_CONFIG, config: h2.worker.strategyConfig });
    const engine = new Engine({ clock, feed: engineFeed(feed, h2.session.policy).feed, strategy, runner: { run: () => undefined }, seed: start.seed, book: { maxOpenPositions: h2.session.policy.positions.maxOpen } });
    engine.drain();
    const replayed = (engine.records as readonly LogRecord[]).flatMap((r) => (r.type === 'decision' ? [{ event: r.eventId, reasons: r.reasons.filter((x) => !x.startsWith(GATE_REASONS_PREFIX)), result: r.result }] : []));
    expect(replayed).toEqual(live);
  });
});
