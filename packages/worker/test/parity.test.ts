// TEST-1: live/replay parity on a recorded worker session. Every check has a planted failure it must catch.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { STATE_FILES } from '../../runner/src/contract.ts';
import { checkBoot, checkSession, firstDivergence, loadSession, normalise, replayBoot, type ParityDeps } from '../src/run/parity.ts';
import { blockNetwork } from './helpers.ts';
import { MINT, Market, makeWorker, passingMarket, type Harness } from './worker-harness.ts';

/** Test-only (POS-1): a held position's price moves with the re-published pool fact. */
const HELD = { heldPoolFacts: true } as const;
import { setSecretValues } from '../src/run/redact.ts';

blockNetwork();

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** A paper session with an entry and an exit: what the recorder and journal hold after a real run. */
const session = async (o: { readonly edgePpm?: bigint } = {}): Promise<Harness> => {
  const h = makeWorker(o.edgePpm === undefined ? {} : { edgePpm: o.edgePpm });
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
  return h;
};

const deps = (h: Harness): ParityDeps => ({ session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig });
const journalPath = (h: Harness) => join(h.stateDir, STATE_FILES.journal);

describe('TEST-1 parity harness', () => {
  it('a recorded session replays to the live decisions byte for byte, ten times, and its ledger replays', async () => {
    const h = await session();
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 10);
    expect(r.boots).toHaveLength(1);
    const b = r.boots[0]!;
    expect(b.decisions).toBeGreaterThan(5);
    expect(b.replays).toBe(10);
    expect(b.deterministic).toBe(true);
    expect(b.divergence).toBeNull();
    expect(r.ledger).toMatchObject({ ok: true, purpose: 'paper' });
    expect(r.ok).toBe(true);
    // The session holds an entry and an exit, so the comparison covers trading decisions, not only rejects.
    const live = loadSession(h.stateDir)[0]!.live;
    expect(live.some((l) => l.includes('"reasons":["enter"'))).toBe(true);
    expect(live.some((l) => l.includes('"reasons":["exit"'))).toBe(true);
    // The comparison is on exact text: the normalised line is the journal line without seq, ts and boot.
    expect(live[0]!.startsWith('{"kind":"decision",')).toBe(true);
  });

  it('a planted divergence is reported at the exact line and event', async () => {
    const h = await session();
    const lines = readFileSync(journalPath(h), 'utf8').split('\n');
    const decisions = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes('"kind":"decision"'));
    // Change the reasons of the fourth compared decision line.
    const [line, at] = decisions[3]!;
    const event = (JSON.parse(line) as { event: string }).event;
    lines[at] = line.replace('"reasons":["', '"reasons":["planted ');
    writeFileSync(journalPath(h), lines.join('\n'));
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 2);
    expect(r.ok).toBe(false);
    expect(r.boots[0]!.divergence).toMatchObject({ index: 3, event });
    expect(r.boots[0]!.divergence!.live).toContain('planted ');
    expect(r.boots[0]!.divergence!.replay).not.toContain('planted ');
  });

  it('a recording that misses events is reported where the replay first runs short', async () => {
    const h = await session();
    const b = loadSession(h.stateDir)[0]!;
    // Drop the releases from the last live decision's event on: the replay ends before live did.
    const lastEvent = (JSON.parse(b.live.at(-1)!) as { event: string }).event;
    const cut = b.releases.findIndex((r) => r.eventId === lastEvent);
    expect(cut).toBeGreaterThan(0);
    const short = replayBoot({ ...b, releases: b.releases.slice(0, cut) }, deps(h));
    const d = firstDivergence(b.live, short);
    expect(d).not.toBeNull();
    expect(d!.index).toBeLessThan(b.live.length);
  });

  it('a nondeterministic replay is caught, even when its first run matches live', async () => {
    const h = await session();
    const b = loadSession(h.stateDir)[0]!;
    let n = 0;
    const flaky = (x: Parameters<typeof replayBoot>[0], d: ParityDeps) => {
      const out = replayBoot(x, d);
      return n++ === 3 ? [...out.slice(0, -1), 'different'] : out;
    };
    const r = checkBoot(b, deps(h), 10, flaky);
    expect(r.divergence).toBeNull();
    expect(r.deterministic).toBe(false);
    expect(checkBoot(b, deps(h), 10).deterministic).toBe(true);
  });

  it('across a restart each boot replays to its own decisions', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await h.worker.kill();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    await h2.worker.reconcile();
    const m2 = new Market(h2, HELD);
    await m2.run(4_000, 400, () => {
      m2.slot();
      m2.pool();
    });
    await h2.worker.stop();
    const r = checkSession(h.stateDir, deps(h2), replayLedgerFile, 3);
    expect(r.boots.map((b) => b.boot)).toEqual([h.worker.boot, h2.worker.boot]);
    for (const b of r.boots) {
      expect(b.decisions).toBeGreaterThan(0);
      expect(b.deterministic).toBe(true);
      expect(b.divergence).toBeNull();
    }
    expect(r.ok).toBe(true);
  });

  it('a ledger that does not replay, or no ledger, fails the session', async () => {
    const h = await session();
    // Planted corruption: the ledger's append-only guards are dropped on this copy so its purpose stamp can be broken.
    const db = new DatabaseSync(join(h.stateDir, 'ledger.sqlite'));
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ledger_meta'").all() as { name: string }[]) db.exec(`DROP TRIGGER "${t.name}"`);
    db.exec("UPDATE ledger_meta SET value = 'bogus' WHERE key = 'purpose'");
    db.close();
    const bad = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    expect(bad.boots.every((b) => b.divergence === null)).toBe(true);
    expect(bad.ledger).toMatchObject({ ok: false });
    expect(bad.ok).toBe(false);
    rmSync(join(h.stateDir, 'ledger.sqlite'));
    const none = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    expect(none.ledger).toBeNull();
    expect(none.ok).toBe(false);
  });

  it('one command: the CLI rebuilds the session and strategy from the journal and exits 0, 1 on a divergence', async () => {
    // As main.ts runs it: no paper edge (none is proven), so risk refuses every entry and the log is the rejects.
    const h = await session({ edgePpm: 0n });
    const run = () => spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'packages/worker/scripts/parity.ts'), h.stateDir, '--replays', '3'], { encoding: 'utf8' });
    const ok = run();
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, ledger: { ok: true } });
    const lines = readFileSync(journalPath(h), 'utf8').split('\n');
    const at = lines.findIndex((l) => l.includes('"reasons":["reject"'));
    expect(at).toBeGreaterThan(0);
    lines[at] = lines[at]!.replace('"reasons":["reject"', '"reasons":["rejected"');
    writeFileSync(journalPath(h), lines.join('\n'));
    const bad = run();
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).boots[0].divergence.live).toContain('"rejected"');
  });

  it('journal lines no engine record makes (a refused API command) are counted, not compared', async () => {
    const h = await session();
    const lines = readFileSync(journalPath(h), 'utf8').split('\n');
    const boot = (JSON.parse(lines[0]!) as { boot: string }).boot;
    lines.splice(5, 0, JSON.stringify({ seq: 999, ts: '2026-10-03T00:00:00.000Z', boot, kind: 'decision', action: 'command_refused', reasons: ['command pause refused', 'needs owner'] }));
    writeFileSync(journalPath(h), lines.join('\n'));
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    expect(r.boots[0]!.excluded).toEqual({ command_refused: 1 });
    expect(r.boots[0]!.divergence).toBeNull();
    expect(r.ok).toBe(true);
  });

  it('a killed session (recorder files still plain, a torn last line) replays from its whole lines', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await h.worker.kill();
    const b = loadSession(h.stateDir)[0]!;
    expect(b.frames.length).toBeGreaterThan(0);
    // A torn line at the end of the open frames file, as a crash mid-write leaves it, is not read.
    const day = readdirSync(join(h.stateDir, 'recorder', h.worker.boot, 'days')).sort().at(-1)!;
    const dir = join(h.stateDir, 'recorder', h.worker.boot, 'days', day);
    const open = readdirSync(dir).filter((f) => /^frames-.*\.jsonl$/.test(f)).sort().at(-1)!;
    appendFileSync(join(dir, open), '{"seq":99999,"torn');
    const again = loadSession(h.stateDir)[0]!;
    expect(again.frames).toHaveLength(b.frames.length);
    const r = checkBoot(again, deps(h), 2);
    expect(r.deterministic).toBe(true);
    expect(r.divergence).toBeNull();
  });

  it('RECORD-BUDGET N2: a boot the byte budget pruned is reported as pruned, not replayed into a divergence', async () => {
    const h = await session();
    const path = join(h.stateDir, STATE_FILES.recorder, h.worker.boot, 'manifest.json');
    const text = readFileSync(path, 'utf8');
    const m = JSON.parse(text) as { pruned: unknown[]; days: { files: { path: string }[] }[] };
    expect(checkSession(h.stateDir, deps(h), replayLedgerFile, 1).boots.map((b) => b.missing)).toEqual([null]);
    // Named in its manifest's pruned.
    writeFileSync(path, JSON.stringify({ ...m, pruned: [{ path: 'days/2026-01-01/frames-000.jsonl.zst', bytes: 1, sha256: null, reason: 'cap' }] }));
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    expect(r.boots.map((b) => b.missing)).toEqual(['pruned']);
    expect(r.ok).toBe(false);
    // Or a file its manifest lists is gone.
    writeFileSync(path, text);
    const listed = m.days.flatMap((d) => d.files.map((f) => f.path));
    expect(listed.length).toBeGreaterThan(0);
    rmSync(join(h.stateDir, STATE_FILES.recorder, h.worker.boot, listed[0]!));
    expect(checkSession(h.stateDir, deps(h), replayLedgerFile, 1).boots.map((b) => b.missing)).toEqual(['pruned']);
  });

  it('a folder with no recording at all is not parity: its deciding boot is reported with no recording', async () => {
    const h = await session();
    rmSync(join(h.stateDir, STATE_FILES.recorder), { recursive: true });
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    expect(r.boots.map((b) => b.missing)).toEqual(['no recording']);
    expect(r.ledger).toMatchObject({ ok: true });
    expect(r.ok).toBe(false);
  });

  it('the replay redacts as the journal does: a value the journal hid stays hidden in the comparison', async () => {
    // A value that appears in decision text but in no market frame (real credentials never are market data; the
    // recorder redacts frames too and lists each as a gap a replay cannot see).
    setSecretValues(['regime off']);
    try {
      const h = await session();
      expect(readFileSync(journalPath(h), 'utf8')).toContain('[redacted]');
      const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
      expect(r.boots[0]!.divergence).toBeNull();
      expect(r.ok).toBe(true);
    } finally {
      setSecretValues([]);
    }
  });

  it('a recording with redacted values is reported as such: its replay cannot match there', async () => {
    // The coin's address treated as a credential: the recorder redacts it from the frames, so the replay sees another
    // coin and diverges. The report says how many values were redacted, so the cause is plain.
    setSecretValues([MINT]);
    try {
      const h = await session();
      const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
      expect(r.boots[0]!.redactions).toBeGreaterThan(0);
      expect(r.boots[0]!.divergence).not.toBeNull();
      expect(r.ok).toBe(false);
    } finally {
      setSecretValues([]);
    }
    const clean = await session();
    expect(checkSession(clean.stateDir, deps(clean), replayLedgerFile, 1).boots[0]!.redactions).toBe(0);
  });

  /** A two-boot session across a kill, for the per-boot checks. */
  const twoBoots = async (): Promise<{ h: Harness; h2: Harness }> => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await h.worker.kill();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    await h2.worker.reconcile();
    const m2 = new Market(h2, HELD);
    await m2.run(4_000, 400, () => {
      m2.slot();
      m2.pool();
    });
    await h2.worker.stop();
    return { h, h2 };
  };

  it('a boot with decisions but no recording fails the session, named as such (review probe: first boot\'s folder deleted)', async () => {
    const { h, h2 } = await twoBoots();
    expect(checkSession(h.stateDir, deps(h2), replayLedgerFile, 1).ok).toBe(true);
    rmSync(join(h.stateDir, STATE_FILES.recorder, h.worker.boot), { recursive: true });
    const r = checkSession(h.stateDir, deps(h2), replayLedgerFile, 1);
    expect(r.boots.map((b) => [b.boot, b.missing])).toEqual([[h.worker.boot, 'no recording'], [h2.worker.boot, null]]);
    expect(r.ok).toBe(false);
  });

  it('a boot with decisions but no seed in its start line fails the session, named as such', async () => {
    const h = await session();
    const lines = readFileSync(journalPath(h), 'utf8').split('\n');
    const at = lines.findIndex((l) => l.includes('"kind":"start"'));
    lines[at] = lines[at]!.replace(/"seed":"[^"]*",/, '');
    writeFileSync(journalPath(h), lines.join('\n'));
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    expect(r.boots[0]!.missing).toBe('no seed');
    expect(r.ok).toBe(false);
  });

  it('any redaction fails the session, even when the decisions still match: altered inputs are not parity evidence', async () => {
    const h = await session();
    const manifest = join(h.stateDir, STATE_FILES.recorder, h.worker.boot, 'manifest.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { coverage_gaps: unknown[] };
    m.coverage_gaps.push({ reason: 'values redacted as credentials; a replay of this file differs there', file: 'days/x/frames-000.jsonl.zst', redactions: 1 });
    writeFileSync(manifest, JSON.stringify(m));
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    expect(r.boots[0]!.redactions).toBe(1);
    expect(r.boots[0]!.divergence).toBeNull();
    expect(r.ok).toBe(false);
  });

  it('a ledger refusal in the journal fails the session (a live engine/ledger divergence); a refused command does not', async () => {
    const h = await session();
    const lines = readFileSync(journalPath(h), 'utf8').split('\n');
    const boot = (JSON.parse(lines[0]!) as { boot: string }).boot;
    lines.splice(5, 0, JSON.stringify({ seq: 998, ts: '2026-10-03T00:00:00.000Z', boot, kind: 'decision', action: 'ledger_refused', reasons: ['ledger refused fill: planted'] }));
    writeFileSync(journalPath(h), lines.join('\n'));
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    expect(r.boots[0]!.excluded).toEqual({ ledger_refused: 1 });
    expect(r.boots[0]!.divergence).toBeNull();
    expect(r.ok).toBe(false);
  });

  it('a boot that decided nothing (a reconcile-only run) needs no recording', async () => {
    const h = await session();
    const lines = readFileSync(journalPath(h), 'utf8').split('\n').filter((l) => l !== '');
    lines.push(JSON.stringify({ seq: 1, ts: '2026-10-04T00:00:00.000Z', boot: 'reconcile-1', kind: 'start', seed: 'paper:reconcile-1' }));
    writeFileSync(journalPath(h), `${lines.join('\n')}\n`);
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    expect(r.boots.map((b) => b.boot)).toEqual([h.worker.boot]);
    expect(r.ok).toBe(true);
  });

  it('a boot whose only decision lines are ledger refusals is not skipped: its refusal fails the session', async () => {
    const h = await session();
    const lines = readFileSync(journalPath(h), 'utf8').split('\n').filter((l) => l !== '');
    lines.push(JSON.stringify({ seq: 1, ts: '2026-10-04T00:00:00.000Z', boot: 'refused-1', kind: 'start', seed: 'paper:refused-1' }));
    lines.push(JSON.stringify({ seq: 2, ts: '2026-10-04T00:00:01.000Z', boot: 'refused-1', kind: 'decision', action: 'ledger_refused', reasons: ['ledger refused fill: planted'] }));
    writeFileSync(journalPath(h), `${lines.join('\n')}\n`);
    const r = checkSession(h.stateDir, deps(h), replayLedgerFile, 1);
    const b = r.boots.find((x) => x.boot === 'refused-1');
    expect(b).toMatchObject({ excluded: { ledger_refused: 1 } });
    expect(r.ok).toBe(false);
  });

  it('normalise drops only seq, ts and boot', () => {
    expect(normalise('{"seq":12,"ts":"2026-10-03T00:00:00.000Z","boot":"abc-1","kind":"decision","event":"x"}')).toBe('{"kind":"decision","event":"x"}');
    expect(normalise('{"kind":"decision","seq":1}')).toBe('{"kind":"decision","seq":1}');
  });
});
