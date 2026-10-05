// WORKER-1c item 1: PERSIST-1 wired into the worker. A clean stop (and every 5 minutes) saves the deployer index, the
// rug labeller and the coverage facts; the next start restores them through the recorded seed fact before any
// decision, tops up the downtime from the saved moment, and never saves before the seed is applied.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { SEED_KEY } from '../src/engine/strategy.ts';
import type { Frame } from '../src/providers/index.ts';
import { parseTyped } from '../src/run/json.ts';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { RAW } from '../../core/src/facts/raw.ts';
import { GRADUATES_KEY, survivalCondition } from '../../core/src/gates/index.ts';
import { DailyBudget, fileSha256, loadState, packFile } from '../src/persist/index.ts';
import { SavedStateMissing, checkBoot, loadSession, replayBoot, savedStateOf } from '../src/run/parity.ts';
import { FILL_BUDGET_FILE, FILL_CREDITS_PER_DAY, SEED_CREDIT_CAP, runSeed } from '../src/run/seed-start.ts';
import { PERSIST_EVERY_MS, PERSIST_FILE, SAVED_STATES, type SeedRequest, type SeedResult } from '../src/run/worker.ts';
import { DEV, MINT, Market, T, dueTimers, makeWorker, passingMarket, slotAt, tempState, virtualTimers } from './worker-harness.ts';

const emptyRpc = { getSignaturesForAddress: async () => [{ signature: 'before-the-range', slot: 0n, err: null, blockTime: 0 }], getTransaction: async () => null };
const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);

const boot = async (h: ReturnType<typeof makeWorker>, before?: (m: Market) => void) => {
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
  before?.(m);
  expect(await started).toEqual({ ok: true });
  await m.run(3_000, 400, () => m.slot());
  return m;
};

describe('PERSIST-1 in the worker', () => {
  it('a clean stop saves; the restart restores the index through the seed fact before any decision and fills from the saved moment', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const h = makeWorker({ stateDir, timers, seed });
    const m = await boot(h);
    m.create();
    await m.run(1_000, 200, () => m.slot());
    expect(h.worker.strategy.deployers.factFor(DEV, { slot: 1n << 40n, txIndex: 0, ixIndex: 0, receivedAt: timers.now() }, 0).mints.map((x) => x.mint)).toEqual([MINT]);
    await h.worker.stop();
    const file = join(stateDir, PERSIST_FILE);
    expect(existsSync(file)).toBe(true);
    const saved = loadState(file, RUG_CONFIG);
    expect(saved.ok).toBe(true);
    const savedBytes = readFileSync(file);
    const asOf = saved.ok ? saved.asOf : null;

    timers.set(timers.now() + 10 * 60_000);
    const requests: SeedRequest[] = [];
    const h2 = makeWorker({ stateDir, timers, seed: (r) => (requests.push(r), seed(r)) });
    expect(h2.logs.some((l) => l.startsWith(`Saved state restored as of slot ${asOf!.slot}`))).toBe(true);
    await boot(h2);
    // The fill starts at the saved moment and closes the restart gap the restore opened on the live creates watch.
    expect(requests[0]!.saved.last).toEqual({ slot: asOf!.slot, ms: asOf!.receivedAt });
    expect(requests[0]!.close).toEqual({ via: VIA, fromSlot: asOf!.slot });
    // The index came back from the file (no create was seen by this process), and the restore is the seed decision.
    expect(h2.worker.strategy.deployers.factFor(DEV, { slot: 1n << 40n, txIndex: 0, ixIndex: 0, receivedAt: timers.now() }, 0).mints.map((x) => x.mint)).toEqual([MINT]);
    // The labeller's tables came back as saved (this process saw no launch of its own).
    expect(h2.worker.strategy.persistable(0)?.state.labeller).toEqual(saved.ok ? saved.labeller.snapshot() : null);
    const seeds = journal(stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision' && /^seed/.test(((l['reasons'] as string[]) ?? [])[0] ?? ''));
    expect(seeds.map((l) => (l['reasons'] as string[]).slice(0, 2))).toEqual([['seed', expect.stringMatching(/^saved state restored/)]]);
    await h2.worker.stop();
    // The next save carries the restored coverage history too: boot 1's watch start and the restart gap on it.
    const second = loadState(join(stateDir, PERSIST_FILE), RUG_CONFIG);
    expect(second.ok).toBe(true);
    const cov = second.ok ? second.coverage.map((e) => ({ key: e.key, v: (e.value as { value: Record<string, unknown> }).value })) : [];
    expect(cov.filter((c) => c.key === 'coverage:creates:start' && c.v['via'] === VIA).length).toBeGreaterThanOrEqual(2);
    expect(cov).toContainEqual({ key: 'coverage:creates:gap', v: expect.objectContaining({ reason: 'restart', via: VIA, fromSlot: asOf!.slot }) });
    // Replay parity (WORKER-GROW): the recorded seed names the saved file by the sha256 of its bytes; the boot's recording
    // holds that copy (listed in its manifest), byte for byte the file this boot restored from.
    const rec = join(stateDir, 'recorder', h2.worker.boot);
    const dir = join(rec, 'days');
    const frames = readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).filter((f) => /^frames-/.test(f)).map((f) => zstdDecompressSync(readFileSync(join(dir, d, f))).toString('utf8')))
      .join('\n').split('\n').filter((l) => l !== '').map((l) => parseTyped(l) as Frame);
    const seedFrame = frames.find((f) => f.body.type === 'fact' && f.body.key === SEED_KEY);
    // G4c: the copy is packed once the restore read it; it decompresses to exactly those bytes, whose sha256 the seed names.
    const copy = join(rec, PERSIST_FILE);
    expect(existsSync(copy)).toBe(false);
    const packed = readFileSync(`${copy}.zst`);
    expect(zstdDecompressSync(packed).equals(savedBytes)).toBe(true);
    const ref = { file: PERSIST_FILE, sha256: createHash('sha256').update(savedBytes).digest('hex'), version: 2 };
    expect((seedFrame?.body as { value: { state?: unknown } }).value.state).toEqual({ ref });
    const manifest = JSON.parse(readFileSync(join(rec, 'manifest.json'), 'utf8')) as { attachments: unknown[] };
    expect(manifest.attachments).toEqual([{
      file: `${PERSIST_FILE}.zst`, sha256: createHash('sha256').update(packed).digest('hex'), bytes: packed.length,
      content: { encoding: 'zstd', sha256: ref.sha256, bytes: savedBytes.length },
    }]);
  }, 60_000);

  it('the observe-only start (the tabletop) packs its recording\'s copy too (G4c-2)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const h = makeWorker({ stateDir, timers, seed: (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers }) });
    const m = await boot(h);
    m.create();
    await m.run(1_000, 200, () => m.slot());
    await h.worker.stop();
    const h2 = makeWorker({ stateDir, timers });
    expect(await h2.worker.observeOnly()).toEqual({ ok: true });
    await h2.worker.whenPacked();
    const copy = join(stateDir, 'recorder', h2.worker.boot, PERSIST_FILE);
    expect([existsSync(copy), existsSync(`${copy}.zst`)]).toEqual([false, true]);
    await h2.worker.stop();
  });

  it('a restart loop that never saves keeps one packed copy: every boot and pre-step links to it, and parity still checks the bytes (STATE-DEDUPE)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const first = makeWorker({ stateDir, timers, seed });
    const m = await boot(first);
    m.create();
    await m.run(1_000, 200, () => m.slot());
    await first.worker.stop();
    const sha = fileSha256(join(stateDir, PERSIST_FILE));
    // Three restarts shorter than a save (killed): each the unit's pre-step, then the start, on the same saved bytes.
    const boots: string[] = [];
    for (let k = 0; k < 3; k++) {
      timers.set(timers.now() + 60_000);
      const pre = makeWorker({ stateDir, timers, seed });
      expect(await pre.worker.reconcileOnly()).toEqual({ ok: true });
      boots.push(pre.worker.boot);
      const h = makeWorker({ stateDir, timers, seed });
      await boot(h);
      await h.worker.whenPacked();
      boots.push(h.worker.boot);
      await h.worker.kill();
    }
    expect(fileSha256(join(stateDir, PERSIST_FILE))).toBe(sha);
    const stored = join(stateDir, 'recorder', SAVED_STATES, `${sha}.zst`);
    expect(readdirSync(join(stateDir, 'recorder', SAVED_STATES))).toEqual([`${sha}.zst`]);
    const ino = statSync(stored).ino;
    for (const b of boots) {
      const copy = join(stateDir, 'recorder', b, PERSIST_FILE);
      expect(existsSync(copy), b).toBe(false);
      expect(statSync(`${copy}.zst`).ino, b).toBe(ino);
    }
    // One file on disk for the six boots: the stored copy and its six links.
    expect(statSync(stored).nlink).toBe(boots.length + 1);
    // Each boot's manifest lists its packed copy with the plain bytes' hash.
    const manifest = JSON.parse(readFileSync(join(stateDir, 'recorder', boots[1]!, 'manifest.json'), 'utf8')) as { attachments: { file: string; content?: { sha256: string } }[] };
    expect(manifest.attachments).toEqual([expect.objectContaining({ file: `${PERSIST_FILE}.zst`, content: expect.objectContaining({ sha256: sha }) })]);
    // Parity: each started boot restores from its link; a missing link, or the shared bytes changed, is refused.
    const d = { session: first.session, rugs: RUG_CONFIG, strategy: first.worker.strategyConfig };
    const session = loadSession(stateDir);
    const started = session.find((b) => b.boot === boots[1])!;
    expect(started.savedState).toBe(join(stateDir, 'recorder', boots[1]!, `${PERSIST_FILE}.zst`));
    expect(() => savedStateOf(started, d)).not.toThrow();
    rmSync(join(stateDir, 'recorder', boots[3]!, `${PERSIST_FILE}.zst`));
    expect(() => replayBoot(loadSession(stateDir).find((b) => b.boot === boots[3])!, d)).toThrow(/the recording has no copy of it/);
    const plain = Buffer.from(zstdDecompressSync(readFileSync(stored)));
    plain[plain.length - 10] = plain[plain.length - 10] === 0x30 ? 0x31 : 0x30;
    writeFileSync(stored, zstdCompressSync(plain));
    expect(() => replayBoot(loadSession(stateDir).find((b) => b.boot === boots[5])!, d)).toThrow(/the recording's copy has sha256/);
  }, 60_000);

  it('the pack runs beside the start: a slow disk never delays the feeds; a stop waits for the pack (review of #217)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const first = makeWorker({ stateDir, timers, seed });
    const m = await boot(first);
    m.create();
    await m.run(1_000, 200, () => m.slot());
    await first.worker.stop();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = makeWorker({ stateDir, timers, seed, pack: async (path, content) => (await gate, packFile(path, content)) });
    const started = h.worker.start();
    // The feeds start while the pack is held (it used to come first, by however long the disk took).
    for (let k = 0; k < 200 && !h.order.includes('start helius-ws'); k++) await new Promise<void>((r) => setImmediate(r));
    expect(h.order).toContain('start helius-ws');
    const copy = join(stateDir, 'recorder', h.worker.boot, PERSIST_FILE);
    expect([existsSync(copy), existsSync(`${copy}.zst`)]).toEqual([true, false]);
    // A stop waits for the pack before the recorder closes: its manifest lists the packed copy.
    let stopped = false;
    const stop = h.worker.stop().then(() => (stopped = true));
    for (let k = 0; k < 50; k++) await new Promise<void>((r) => setImmediate(r));
    expect(stopped).toBe(false);
    release();
    await stop;
    await started;
    expect([existsSync(copy), existsSync(`${copy}.zst`)]).toEqual([false, true]);
    const manifest = JSON.parse(readFileSync(join(stateDir, 'recorder', h.worker.boot, 'manifest.json'), 'utf8')) as { attachments: { file: string }[] };
    expect(manifest.attachments.map((x) => x.file)).toEqual([`${PERSIST_FILE}.zst`]);
  }, 60_000);

  it('a stored copy that no longer holds the bytes is never linked: the boot packs its own (STATE-DEDUPE)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const first = makeWorker({ stateDir, timers, seed });
    const m = await boot(first);
    m.create();
    await m.run(1_000, 200, () => m.slot());
    await first.worker.stop();
    const sha = fileSha256(join(stateDir, PERSIST_FILE));
    const stored = join(stateDir, 'recorder', SAVED_STATES, `${sha}.zst`);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(stateDir, 'recorder', SAVED_STATES), { recursive: true });
    writeFileSync(stored, zstdCompressSync(Buffer.from('not the saved state')));
    const h = makeWorker({ stateDir, timers, seed });
    await boot(h);
    await h.worker.whenPacked();
    const own = join(stateDir, 'recorder', h.worker.boot, `${PERSIST_FILE}.zst`);
    expect(statSync(own).ino).not.toBe(statSync(stored).ino);
    expect(createHash('sha256').update(zstdDecompressSync(readFileSync(own))).digest('hex')).toBe(sha);
    expect(h.logs.some((l) => l.includes(`the stored saved state ${sha} decompresses to sha256`))).toBe(true);
    // The bad stored file is left as it is (state copies are never deleted).
    expect(zstdDecompressSync(readFileSync(stored)).toString()).toBe('not the saved state');
    await h.worker.stop();
  }, 60_000);

  it('a coin created 16 days before its migration: the shortlist reads its create again, and the parity replay reproduces the live decisions (WORKER-GROW)', async () => {
    const reads: string[] = [];
    let m: Market | null = null;
    const h = makeWorker({ seed: (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers: h.timers }), readCreateAgain: async (sig) => {
      reads.push(sig);
      if (sig !== 'create-1') return 'not-found';
      m!.create();
      return 'found';
    } });
    m = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m.slot();
    m.create();
    expect(await started).toEqual({ ok: true });
    await m.run(3_000, 400, () => m!.slot());
    const pm = await passingMarket(h, { heldPoolFacts: true });
    m = pm;
    await pm.run(4_000, 100, () => pm.pool());
    await pm.run(10_000, 400, () => { pm.slot(); pm.pool(); });
    expect(reads).toEqual(['create-1']);
    await h.worker.stop();
    const b = loadSession(h.stateDir).find((x) => x.boot === h.worker.boot)!;
    const d = { session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig };
    expect(b.live.some((l) => l.includes('"shortlist"'))).toBe(true);
    // The pending mark and the create read again are in the recording, so the replay sees what live saw.
    expect(b.frames.some((f) => f.body.type === 'fact' && f.body.key === `gates/create-unread:${MINT}`)).toBe(true);
    expect(b.frames.filter((f) => f.body.type === 'fact' && f.body.key === `pump:CreateEvent:${MINT}`).length).toBe(2);
    expect(checkBoot(b, d, 3)).toMatchObject({ missing: null, deterministic: true, divergence: null });
    expect(replayBoot(b, d)).toEqual(b.live);
  }, 60_000);

  it('the parity replay restores a restarted boot from its recording\'s copy and reproduces its decisions; it refuses loudly without exactly that copy (WORKER-GROW)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const h = makeWorker({ stateDir, timers, seed });
    const m = await boot(h);
    m.create();
    await m.run(1_000, 200, () => m.slot());
    await h.worker.stop();
    timers.set(timers.now() + 10 * 60_000);
    const h2 = makeWorker({ stateDir, timers, seed });
    const m2 = await boot(h2);
    await m2.run(1_000, 200, () => m2.slot());
    await h2.worker.stop();
    const b2 = loadSession(stateDir).find((b) => b.boot === h2.worker.boot)!;
    const copy = join(stateDir, 'recorder', h2.worker.boot, `${PERSIST_FILE}.zst`);
    expect(b2.savedState).toBe(copy);
    expect(b2.live.some((l) => l.includes('saved state restored'))).toBe(true);
    const d = { session: h2.session, rugs: RUG_CONFIG, strategy: h2.worker.strategyConfig };
    // From the copy: the same decision lines as live, every replay.
    const r = checkBoot(b2, d, 3);
    expect(r).toMatchObject({ missing: null, deterministic: true, divergence: null });
    expect(replayBoot(b2, d)).toEqual(b2.live);
    // No copy, one byte changed, or another well-formed saved state (its own checksum holds; only the seed's hash
    // tells): refused before anything is replayed, never an empty or other state.
    expect(() => replayBoot({ ...b2, savedState: null }, d)).toThrow(SavedStateMissing);
    expect(() => replayBoot({ ...b2, savedState: null }, d)).toThrow(/the recording has no copy of it; nothing is replayed/);
    const plainBytes = zstdDecompressSync(readFileSync(copy));
    const altered = join(tempState(), PERSIST_FILE);
    const bytes = Buffer.from(plainBytes);
    bytes[bytes.length - 10] = bytes[bytes.length - 10] === 0x30 ? 0x31 : 0x30;
    writeFileSync(altered, bytes);
    expect(() => replayBoot({ ...b2, savedState: altered }, d)).toThrow(/the recording's copy has sha256/);
    // The same change inside a packed copy, and a packed copy that does not decompress: refused too.
    const alteredPacked = join(tempState(), `${PERSIST_FILE}.zst`);
    writeFileSync(alteredPacked, zstdCompressSync(bytes));
    expect(() => replayBoot({ ...b2, savedState: alteredPacked }, d)).toThrow(/the recording's copy has sha256/);
    const torn = join(tempState(), `${PERSIST_FILE}.zst`);
    writeFileSync(torn, readFileSync(copy).subarray(0, 40));
    // (Node's zstd may return a cut file's partial output without an error; the plain bytes' hash refuses it either way.)
    expect(() => replayBoot({ ...b2, savedState: torn }, d)).toThrow(SavedStateMissing);
    expect(() => replayBoot({ ...b2, savedState: torn }, d)).toThrow(/(unreadable|has sha256).*nothing is replayed/);
    // The plain copy (a pack that failed) replays the same.
    const unpacked = join(tempState(), PERSIST_FILE);
    writeFileSync(unpacked, plainBytes);
    expect(replayBoot({ ...b2, savedState: unpacked }, d)).toEqual(b2.live);
    const other = join(stateDir, PERSIST_FILE);
    expect(loadState(other, RUG_CONFIG).ok).toBe(true);
    expect(fileSha256(other)).not.toBe(fileSha256(unpacked));
    expect(() => replayBoot({ ...b2, savedState: other }, d)).toThrow(/the recording's copy has sha256/);
    // The copy is handed over once, and only for exactly the reference the seed names.
    // The seed's hash is the plain bytes' (the copy is packed).
    const ref = { file: PERSIST_FILE, sha256: createHash('sha256').update(plainBytes).digest('hex'), version: 2 };
    const once = savedStateOf(b2, d);
    expect(once.savedState!(ref).index.factFor(DEV, { slot: 1n << 40n, txIndex: 0, ixIndex: 0, receivedAt: timers.now() }, 0).mints.map((x) => x.mint)).toEqual([MINT]);
    expect(() => once.savedState!(ref)).toThrow(SavedStateMissing);
    expect(() => once.savedState!(ref)).toThrow(/a second or different saved state asked for/);
    for (const bad of [{ ...ref, sha256: '0'.repeat(64) }, { ...ref, file: 'other.json' }, { ...ref, version: 1 }]) {
      expect(() => savedStateOf(b2, d).savedState!(bad)).toThrow(/a second or different saved state asked for/);
    }
  }, 60_000);

  it('the restored state is handed to the seed that names it, by file, sha256 and version, and only once (WORKER-GROW)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const h = makeWorker({ stateDir, timers, seed: (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers }) });
    const m = await boot(h);
    m.create();
    await m.run(1_000, 200, () => m.slot());
    await h.worker.stop();
    const h2 = makeWorker({ stateDir, timers });
    const ref = { file: PERSIST_FILE, sha256: fileSha256(join(stateDir, 'recorder', h2.worker.boot, PERSIST_FILE)), version: 2 };
    for (const bad of [{ ...ref, sha256: '0'.repeat(64) }, { ...ref, file: 'other.json' }, { ...ref, version: 1 }]) {
      expect(() => h2.worker.savedStateFor(bad)).toThrow(/not the one this process restored/);
    }
    expect(h2.worker.savedStateFor(ref).index.factFor(DEV, { slot: 1n << 40n, txIndex: 0, ixIndex: 0, receivedAt: timers.now() }, 0).mints.map((x) => x.mint)).toEqual([MINT]);
    expect(() => h2.worker.savedStateFor(ref)).toThrow(/not the one this process restored/);
    await h2.worker.stop();
  });

  it('PERSIST-2: a restart inside the 14-day window keeps survival known (the series comes back through a recorded seed read)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const h = makeWorker({ stateDir, timers, seed });
    const m = await boot(h);
    // 16 days of graduates, one every 6 hours, the newest well past its +30 min mark.
    const P = TRIAL_POLICY.regime;
    const items = Array.from({ length: 64 }, (_, k) => ({ mint: `Grad${k}`, migratedAtMs: m.now - 2 * 3_600_000 - k * 6 * 3_600_000, reserveAfter: k % 3 === 0 ? 1n : 100_000_000_000n }))
      .sort((a, b) => a.migratedAtMs - b.migratedAtMs);
    // One more graduate whose +30 min mark is still ahead at the save: it is not saved.
    const young = { mint: 'Young', migratedAtMs: m.now - 10 * 60_000, reserveAfter: 1n };
    m.fact(GRADUATES_KEY, { obs: { provider: 'facts', slot: null, receivedAt: m.now, quality: [] }, items: [...items, young] });
    await m.run(1_000, 200, () => m.slot());
    expect(survivalCondition({ obs: { provider: 'facts', slot: null, receivedAt: m.now, quality: [] }, items }, m.now, P).ok).not.toBeNull();
    await h.worker.stop();
    const saved = loadState(join(stateDir, PERSIST_FILE), RUG_CONFIG);
    expect(saved.ok && saved.graduates?.items).toEqual(items);

    timers.set(timers.now() + 10 * 60_000);
    const h2 = makeWorker({ stateDir, timers, seed });
    const m2 = await boot(h2);
    // This process saw no graduate of its own: the producer's series is the saved one, and survival is computed.
    const back = h2.worker.strategy.persistable(0)?.state.graduates;
    expect(back?.items).toEqual(items);
    expect(survivalCondition({ obs: { provider: 'facts', slot: null, receivedAt: m2.now, quality: [] }, items: back!.items }, m2.now, P).ok).not.toBeNull();
    // The seed's outcome is journaled and shown in /health.
    expect(h2.worker.health().graduates_seed).toEqual({ source: 'persist', accepted: true, added: items.length, reason: null });
    expect(journal(stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'graduates_seed').map((l) => l['accepted'])).toEqual([true]);
    await h2.worker.stop();
    // A host clock behind the save (a VM restored, NTP stepping back): the seed is dated after its release and refused,
    // visibly, so the regime's unknown survival has a named cause.
    const behind = makeWorker({ stateDir, timers: virtualTimers(saved.ok ? saved.asOf.receivedAt - 3_600_000 : 0), seed });
    expect(behind.worker.health().graduates_seed).toBeUndefined();
    await boot(behind);
    expect(behind.worker.health().graduates_seed).toMatchObject({ source: 'persist', accepted: false, added: 0, reason: expect.stringMatching(/after its release/) });
    expect(behind.logs.some((l) => l.startsWith('ALERT graduates seed refused: '))).toBe(true);
    expect(journal(stateDir).filter((l) => l['boot'] === behind.worker.boot && l['kind'] === 'graduates_seed').map((l) => l['accepted'])).toEqual([false]);
    await behind.worker.stop();
    // Replay parity: the series travels as a recorded raw read.
    const dir = join(stateDir, 'recorder', h2.worker.boot, 'days');
    const frames = readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).filter((f) => /^frames-/.test(f)).map((f) => zstdDecompressSync(readFileSync(join(dir, d, f))).toString('utf8')))
      .join('\n').split('\n').filter((l) => l !== '').map((l) => parseTyped(l) as Frame);
    const seedRead = frames.find((f) => f.body.type === 'offchain' && f.body.key === RAW.graduatesSeed);
    expect((seedRead?.body as { value: { source: string; items: unknown } }).value).toMatchObject({ source: 'persist', items });
  }, 60_000);

  it('saves every PERSIST_EVERY_MS once the seed is applied, and never before it', async () => {
    const stateDir = tempState();
    // Timers that fire only when the clock reaches them, so the seed's 1 h cap does not elapse at once.
    const timers = dueTimers(T);
    let release: (r: SeedResult) => void = () => undefined;
    const h = makeWorker({ stateDir, timers, seed: () => new Promise((r) => (release = r)), seedMaxMs: 3_600_000, seedWaitMs: 1_000 });
    const m = new Market(h);
    const started = h.worker.start();
    for (let k = 0; k < 200 && !h.order.includes('start helius-ws'); k++) {
      timers.set(timers.now() + 100);
      await new Promise<void>((r) => setImmediate(r));
    }
    m.slot();
    m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
    // Seeding: well past the save interval, and still no file.
    await m.run(PERSIST_EVERY_MS + 60_000, 30_000, () => m.slot());
    expect(h.worker.strategy.seedApplied).toBe(false);
    expect(existsSync(join(stateDir, PERSIST_FILE))).toBe(false);
    expect(h.logs).toContain('Saved state not written: the seed is not applied yet.');
    release({ mode: 'none', creates: [], coverage: [], report: 'test' });
    await m.run(PERSIST_EVERY_MS + 60_000, 30_000, () => m.slot());
    expect(await started).toEqual({ ok: true });
    expect(h.worker.strategy.seedApplied).toBe(true);
    expect(existsSync(join(stateDir, PERSIST_FILE))).toBe(true);
    await h.worker.kill();
  }, 60_000);

  it('a damaged file is discarded: the start is a fresh one (no restored state in the seed)', async () => {
    const stateDir = tempState();
    writeFileSync(join(stateDir, PERSIST_FILE), '{"version":1,"sha256":"00","payload":"{}"}');
    const timers = virtualTimers(T);
    const requests: SeedRequest[] = [];
    const h = makeWorker({ stateDir, timers, seed: (r) => (requests.push(r), runSeed(r, { rpc: emptyRpc, timers })) });
    expect(h.logs.some((l) => /^Saved state discarded \(saved state checksum does not match\)/.test(l))).toBe(true);
    await boot(h);
    expect(requests[0]!.saved.last).toBeNull();
    const seeds = journal(stateDir).filter((l) => l['kind'] === 'decision' && /^seed/.test(((l['reasons'] as string[]) ?? [])[0] ?? ''));
    expect((seeds[0]!['reasons'] as string[])[1]).not.toMatch(/saved state/);
    await h.worker.stop();
  }, 60_000);
});

describe('the downtime fill\'s daily budget (PERSIST-1 DailyBudget, wired by WORKER-1c)', () => {
  const DAY = 86_400_000;
  it('a clock stepped back keeps today\'s spend, in memory and after a reload', () => {
    const file = join(tempState(), FILL_BUDGET_FILE);
    const t = 10 * DAY + 5;
    const b = DailyBudget.load(file, 1_000, t);
    b.spend(1_000, t);
    expect(b.remaining(t)).toBe(0);
    expect(b.remaining(t - 10)).toBe(0);
    expect(DailyBudget.load(file, 1_000, t - DAY).remaining(t - DAY)).toBe(0);
    expect(DailyBudget.load(file, 1_000, t + DAY).remaining(t + DAY)).toBe(1_000);
  });

  it('runSeed reserves its cap before the fill reads and gives back what the fill did not use', async () => {
    const file = join(tempState(), FILL_BUDGET_FILE);
    const timers = virtualTimers(T);
    const budget = DailyBudget.load(file, FILL_CREDITS_PER_DAY, timers.now());
    let midRead: unknown = null;
    const rpc = {
      getSignaturesForAddress: async () => {
        midRead ??= JSON.parse(readFileSync(file, 'utf8'));
        return [{ signature: 'before-the-range', slot: 0n, err: null, blockTime: 0 }];
      },
      getTransaction: async () => null,
    };
    const r = await runSeed({ saved: { creates: [], rugs: [], coverage: [], last: { slot: 1_000n, ms: T - 60_000 } }, close: null, untilSlot: 2_000n, liveStart: null, asOf: { slot: 2_000n, txIndex: 0, ixIndex: 0, receivedAt: T }, signal: new AbortController().signal }, { rpc, timers, budget });
    expect(r.mode).toBe('fill');
    // While the fill read, the whole cap was already counted (a crash then cannot spend it again).
    expect(midRead).toMatchObject({ spent: Math.min(SEED_CREDIT_CAP, FILL_CREDITS_PER_DAY) });
    const used = Number(/RPC (\d+) credits/.exec(r.report)![1]);
    expect(budget.remaining(timers.now())).toBe(FILL_CREDITS_PER_DAY - used);
    // A budget already spent: the fill reads nothing.
    budget.spend(budget.remaining(timers.now()), timers.now());
    let calls = 0;
    const counted = { getSignaturesForAddress: async () => (calls++, []), getTransaction: async () => null };
    await runSeed({ saved: { creates: [], rugs: [], coverage: [], last: { slot: 1_000n, ms: T - 60_000 } }, close: null, untilSlot: 2_000n, liveStart: null, asOf: { slot: 2_000n, txIndex: 0, ixIndex: 0, receivedAt: T }, signal: new AbortController().signal }, { rpc: counted, timers, budget });
    expect(calls).toBe(0);
  });
});

describe('the worker\'s one-shot seed key is the one the live rules drop after an hour (WORKER-GROW)', () => {
  it('SEED_KEY is in LIVE_ONE_SHOT', async () => {
    const { LIVE_ONE_SHOT } = await import('../../core/src/gates/index.ts');
    expect(LIVE_ONE_SHOT).toContain(SEED_KEY);
  });
});
