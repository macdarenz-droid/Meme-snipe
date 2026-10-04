// WORKER-1 against its contracts: the process contract (§12.4: config, exit codes, health, drills, journal), the
// watchdog's heartbeat and pause (ops/README.md), the ledger reservation with the account version (RISK-1, LEDGER-1c),
// the month's credit use (FEED-1), the deployer index and rug labeller wiring (GATE-1b, RUG-1), the confirmed create of a
// shortlisted mint, and SEED-1's hook before any live source.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordFromRpc, type RpcTransactionBase64 } from '../../core/src/chain/index.ts';
import { entryKey, intentId, mint as toMint, positionId } from '../../core/src/domain/index.ts';
import { GENESIS, OFF_CHAIN, type LogRecord } from '../../core/src/engine/index.ts';
import { migrationKey } from '../../core/src/gates/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import { emptyBook, type BookEvent } from '../../core/src/lifecycle/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import { NO_LATCHES, evaluateExit } from '../../core/src/risk/index.ts';
import { TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import { PaperAccount, accountFile } from '../src/run/account.ts';
import { verifySignature, parseHeartbeat } from '../../ops/src/watchdog/logic.ts';
import { checkStartHealth, type Health } from '../../runner/src/contract.ts';
import { RESERVE_PREFIX } from '../src/engine/strategy.ts';
import type { HttpRequest } from '../src/providers/index.ts';
import { DEFAULT_LIVE_FEED, LiveFeed } from '../src/providers/index.ts';
import { HELIUS_FREE } from '../src/scheduler/index.ts';
import { REGISTERED_STRATEGIES, SLOT_MS, UNREADABLE, parseConfig, watchTimingProblem } from '../src/run/config.ts';
import { Desk } from '../src/run/desk.ts';
import type { FactContext } from '../src/run/facts.ts';
import { Journal } from '../src/run/journal.ts';
import { redact, setSecretValues } from '../src/run/redact.ts';
import { CreditBook } from '../src/run/sources.ts';
import { MINT, T, Market, makeWorker, slotAt, tempState, virtualTimers } from './worker-harness.ts';

const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('config and exit codes (§12.4)', () => {
  const base = { ZEROED_STATE_DIR: '/tmp/x', ZEROED_MODE: 'paper' };
  it('refuses anything but paper, a missing state directory and a non-loopback health address (exit 2)', () => {
    for (const [env, why] of [
      [{ ...base, ZEROED_MODE: 'live' }, /ZEROED_MODE must be paper/],
      [{ ZEROED_STATE_DIR: '/tmp/x' }, /ZEROED_MODE must be paper/],
      [{ ZEROED_MODE: 'paper' }, /no state directory/],
      [{ ...base, ZEROED_HEALTH_ADDR: '0.0.0.0:8787' }, /loopback/],
      [{ ...base, ZEROED_HEARTBEAT_MS: '10' }, /HEARTBEAT/],
      [{ ...base, ZEROED_WATCH_EVERY_MS: '50' }, /ZEROED_WATCH_EVERY_MS/],
      [{ ...base, ZEROED_WATCH_EVERY_MS: 'x' }, /ZEROED_WATCH_EVERY_MS/],
      [{ ...base, ZEROED_WATCH_EVERY_MS: '2000', ZEROED_WATCH_STALE_MS: '1000' }, /ZEROED_WATCH_STALE_MS/],
      [{ ...base, ZEROED_WATCH_LATENCY_MS: '10' }, /ZEROED_WATCH_LATENCY_MS/],
      [{ ...base, WATCHDOG_URL: 'http://plain.example' }, /https/],
      [{ ...base, ZEROED_WALLET: 'not-an-address' }, /ZEROED_WALLET/],
      [{ ...base, ZEROED_API_ADDR: '100.64.0.1:8788' }, /API address must be loopback/],
      [{ ...base, ZEROED_API_ADDR: '0.0.0.0:8788' }, /API address must be loopback/],
    ] as const) {
      const p = parseConfig(env, () => null);
      expect(p.ok, JSON.stringify(env)).toBe(false);
      if (!p.ok) {
        expect(p.code).toBe(2);
        expect(p.message).toMatch(why);
      }
    }
  });

  it('the position watch reads its period and stale limit from config (WATCH-1), 1 s and 3 s when unset', () => {
    const watch = (env: Record<string, string>) => {
      const p = parseConfig({ ...base, ...env }, () => null);
      return p.ok ? p.config.watch : null;
    };
    expect(watch({})).toEqual({ everyMs: 200, staleMs: 500, latencyMs: 400, verifyMs: 30_000 });
    expect(watch({ ZEROED_WATCH_EVERY_MS: '300', ZEROED_WATCH_STALE_MS: '300', ZEROED_WATCH_LATENCY_MS: '100', ZEROED_WATCH_VERIFY_MS: '300' })).toEqual({ everyMs: 300, staleMs: 300, latencyMs: 100, verifyMs: 300 });
    // WATCH-1c: the verify period is never shorter than the stale limit.
    expect(watch({ ZEROED_WATCH_VERIFY_MS: '499' })).toBeNull();
    expect(watch({ ZEROED_WATCH_VERIFY_MS: 'x' })).toBeNull();
    // Tied to the policy (review of #87): the oldest a watched market can be must stay below the quote age.
    const policyAge = TRIAL_POLICY.gates.maxQuoteAgeMs;
    const release = DEFAULT_LIVE_FEED.horizonSlots * SLOT_MS;
    expect(watchTimingProblem(watch({})!, policyAge, release)).toBeNull();
    // Both bounds at the defaults (ruling (a1')): steady 500 + 200 + 400 + 800 = 1900 < 2000; at a feed's stop
    // 800 + 1900 = 2700 <= 2000 + 800, the 0.7 s window an exit waits out (EXIT-1d).
    expect(release).toBe(800);
    expect(200 + 500 + 400 + release).toBeLessThan(policyAge);
    expect(release + 200 + 500 + 400 + release).toBe(2700);
    expect(release + 200 + 500 + 400 + release).toBeLessThanOrEqual(policyAge + release);
    expect(watchTimingProblem({ everyMs: 200, staleMs: 600, latencyMs: 400 }, policyAge, release)).toMatch(/must stay below the policy's quote age of 2000 ms/);
    expect(watchTimingProblem({ everyMs: 200, staleMs: 599, latencyMs: 400 }, policyAge, release)).toBeNull();
    expect(() => makeWorker({ config: { ZEROED_WATCH_STALE_MS: '1500' } })).toThrow(/quote age/);
  });

  it('reports its own release: ZEROED_GIT_SHA, else the release folder, else unknown', () => {
    const sha = (env: Record<string, string>, release: string | null) => {
      const p = parseConfig({ ...base, ...env }, () => release);
      return p.ok ? p.config.gitSha : null;
    };
    expect(sha({ ZEROED_GIT_SHA: 'abc' }, 'def')).toBe('abc');
    expect(sha({}, 'def')).toBe('def');
    expect(sha({}, null)).toBe('unknown');
  });

  it('the entry exits 2 on a refused config or key material in the environment, before opening anything', () => {
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--no-warnings', 'packages/worker/src/main.ts'], { cwd: ROOT, env: { PATH: process.env['PATH'] ?? '', ...env }, encoding: 'utf8', timeout: 30_000 });
    const dir = tempState();
    expect(run({ ZEROED_STATE_DIR: dir, ZEROED_MODE: 'live' }).status).toBe(2);
    const late = run({ ZEROED_STATE_DIR: dir, ZEROED_MODE: 'paper', ZEROED_WATCH_STALE_MS: '1500' });
    expect(late.status).toBe(2);
    expect(late.stderr).toMatch(/quote age/);
    const keyed = run({ ZEROED_STATE_DIR: dir, ZEROED_MODE: 'paper', BOT_PRIVATE_KEY: 'x' });
    expect(keyed.status).toBe(2);
    expect(keyed.stderr).toContain('BOT_PRIVATE_KEY');
    expect(keyed.stderr).not.toContain('=x');
  });
});

describe('S0 shakedown settings (supervisor ruling 2026-10-04)', () => {
  const base = { ZEROED_STATE_DIR: '/tmp/x', ZEROED_MODE: 'paper' };
  const refused = (env: Record<string, string>) => {
    const p = parseConfig(env, () => null);
    return p.ok ? null : p.message;
  };
  it('the paper-only edge is refused in any other mode, without S0, and out of range', () => {
    expect(refused({ ...base, ZEROED_MODE: 'live', ZEROED_STRATEGY: 'S0', ZEROED_PAPER_EDGE_PPM: '250000' })).toBe('refused: ZEROED_PAPER_EDGE_PPM is a paper-only setting');
    expect(refused({ ...base, ZEROED_PAPER_EDGE_PPM: '250000' })).toBe('refused: ZEROED_PAPER_EDGE_PPM is only for the S0 shakedown');
    for (const v of ['0', '-5', '1.5', '1000001', 'x']) expect(refused({ ...base, ZEROED_STRATEGY: 'S0', ZEROED_PAPER_EDGE_PPM: v }), v).toMatch(/whole number from 1 to 1000000/);
    expect(refused({ ...base, ZEROED_STRATEGY: 'S1' })).toMatch(/none, S0 or a registered strategy/);
  });
  it('S0 and the paper edge never reach the qualifying run; only a registered strategy could qualify (none is yet)', () => {
    const q = (env: Record<string, string>, run: string | null | typeof UNREADABLE) => {
      const p = parseConfig({ ...base, ...env }, () => null, run);
      return p.ok ? p.config.strategy : p.message;
    };
    expect(q({ ZEROED_RUN_ID: 'qual-1', ZEROED_STRATEGY: 'S0' }, 'qual-1')).toBe('refused: S0 and ZEROED_PAPER_EDGE_PPM are never used in the qualifying run');
    expect(q({ ZEROED_RUN_ID: 'qual-1', ZEROED_STRATEGY: 'S0', ZEROED_PAPER_EDGE_PPM: '250000' }, 'qual-1')).toBe('refused: S0 and ZEROED_PAPER_EDGE_PPM are never used in the qualifying run');
    expect(q({ ZEROED_RUN_ID: 'qual-1' }, 'qual-1')).toBe('refused: the qualifying run needs a registered strategy in ZEROED_STRATEGY');
    expect(q({ ZEROED_RUN_ID: 'qual-1' }, UNREADABLE)).toBe('refused: packages/runner/qualifying-run.json is unreadable');
    // Any other run (a rehearsal, the shakedown) is never qualifying.
    expect(q({ ZEROED_RUN_ID: 'shakedown-1', ZEROED_STRATEGY: 'S0', ZEROED_PAPER_EDGE_PPM: '250000' }, 'qual-1')).toEqual({ name: 'S0', paperEdgePpm: 250_000n, qualifying: false, s0Diagnostic: false });
    expect(REGISTERED_STRATEGIES).toEqual([]);
  });

  it('fails closed on the host: with the file in the release and no run id, the worker is the qualifying run', () => {
    const q = (env: Record<string, string>, run: string | null) => {
      const p = parseConfig({ ...base, ...env }, () => null, run);
      return p.ok ? p.config.strategy : p.message;
    };
    expect(q({ ZEROED_STRATEGY: 'S0' }, 'qual-1')).toBe('refused: S0 and ZEROED_PAPER_EDGE_PPM are never used in the qualifying run');
    expect(q({ ZEROED_STRATEGY: 'S0', ZEROED_PAPER_EDGE_PPM: '250000' }, 'qual-1')).toBe('refused: S0 and ZEROED_PAPER_EDGE_PPM are never used in the qualifying run');
    expect(q({ ZEROED_RUN_ID: '', ZEROED_STRATEGY: 'S0' }, 'qual-1')).toBe('refused: S0 and ZEROED_PAPER_EDGE_PPM are never used in the qualifying run');
    expect(q({}, 'qual-1')).toBe('refused: the qualifying run needs a registered strategy in ZEROED_STRATEGY');
    // No file in the release: nothing is qualifying, so S0 runs (the shakedown).
    expect(q({ ZEROED_STRATEGY: 'S0', ZEROED_PAPER_EDGE_PPM: '250000' }, null)).toEqual({ name: 'S0', paperEdgePpm: 250_000n, qualifying: false, s0Diagnostic: false });
  });

  it('S0 is selectable and always non-qualifying; unset is none with no edge', () => {
    const p = parseConfig({ ...base, ZEROED_STRATEGY: 'S0', ZEROED_PAPER_EDGE_PPM: '250000' }, () => null);
    expect(p.ok && p.config.strategy).toEqual({ name: 'S0', paperEdgePpm: 250_000n, qualifying: false, s0Diagnostic: false });
    const q = parseConfig(base, () => null);
    expect(q.ok && q.config.strategy).toEqual({ name: 'none', paperEdgePpm: null, qualifying: false, s0Diagnostic: false });
  });
});

describe('journal (§12.4)', () => {
  it('continues seq across boots and cuts a torn last line with a repair flag', () => {
    const dir = tempState();
    const path = join(dir, 'journal.jsonl');
    const a = new Journal(path, 'b1', () => T);
    a.write('start');
    a.write('reconcile', { ok: true });
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"seq":3,"ts":"2026`);
    const b = new Journal(path, 'b2', () => T);
    expect(b.repaired).toBe(true);
    b.write('start');
    expect(readFileSync(path, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([1, 2, 3]);
  });
});

describe('heartbeat and the watchdog pause (ops/README.md worker contract)', () => {
  it('sends the watchdog fields signed for /heartbeat only, and applies the reply both ways', async () => {
    const sent: HttpRequest[] = [];
    let paused = true;
    const key = 'test-heartbeat-key';
    const h = makeWorker({ key, http: async (req) => {
      sent.push(req);
      return { status: 200, header: () => null, text: JSON.stringify({ ok: true, paused }) };
    } });
    await h.worker.reconcile();
    await h.worker.heartbeat();
    const req = sent[0]!;
    expect(req.url).toBe('https://watchdog.example.workers.dev/heartbeat');
    const body = req.body!;
    const hb = parseHeartbeat(body);
    expect(hb).not.toBeNull();
    expect(hb).toMatchObject({ git_sha: 'testsha', owner_chat_id: '42', signer: 'none', paused: false, open_position: null });
    const sig = req.headers!['x-zeroed-signature']!;
    const nowS = Math.floor(h.timers.now() / 1000);
    expect(await verifySignature(sig, 'POST', '/heartbeat', body, key, nowS)).not.toBeNull();
    // A heartbeat's signature never opens another route.
    expect(await verifySignature(sig, 'POST', '/resume', body, key, nowS)).toBeNull();

    // paused: true stops entries (an owner pause in the book) and is kept across a restart.
    h.worker.step();
    await new Market(h).run(3_000);
    expect(h.worker.book.paused).toContain('owner');
    expect(JSON.parse(readFileSync(join(h.stateDir, 'control.json'), 'utf8'))).toMatchObject({ paused: true });
    expect(lines(h.stateDir).filter((l) => l['kind'] === 'halt').at(-1)!['reasons']).toEqual(expect.arrayContaining(['owner pause (watchdog)']));
    // paused: false allows entries again.
    paused = false;
    await h.worker.heartbeat();
    await new Market(h).run(3_000);
    expect(h.worker.book.paused).not.toContain('owner');
    expect(JSON.parse(readFileSync(join(h.stateDir, 'control.json'), 'utf8'))).toMatchObject({ paused: false });
    expect(lines(h.stateDir).filter((l) => l['kind'] === 'halt' || l['kind'] === 'resume').at(-1)!['kind']).toBe('resume');
    await h.worker.stop();
  });

  it('sends nothing without a watchdog key', async () => {
    const sent: HttpRequest[] = [];
    const h = makeWorker({ http: async (req) => {
      sent.push(req);
      throw new Error('unreachable');
    } });
    await h.worker.reconcile();
    await h.worker.heartbeat();
    expect(sent).toEqual([]);
    await h.worker.stop();
  });
});

describe('health and drills on the loopback port (§12.4)', () => {
  it('serves the health the runner accepts as a real worker, drops a feed on the drill and brings it back', async () => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18797' } });
    expect(await h.worker.start()).toEqual({ ok: true });
    // SEED-1 (ruling 2026-10-04): the live creates watch starts first, the seed is built up to its first slot after.
    expect(h.order).toEqual(['sources', 'start helius-ws', 'start pumpportal', 'seed']);
    const health = (await (await fetch('http://127.0.0.1:18797/health')).json()) as Health;
    expect(checkStartHealth(health)).toEqual({ ok: true, problems: [] });
    expect(health).toMatchObject({ mode: 'paper', recorder: 'on', simulation: 'on', signing_key: false, reconciled: true, git_sha: 'testsha' });
    expect(health.stub).toBeUndefined();
    expect(Object.keys(health.feeds).sort()).toEqual(['helius-ws', 'pumpportal']);
    expect(health.feeds['helius-ws']!.critical).toBe(true);

    const token = readFileSync(join(h.stateDir, 'drill.token'), 'utf8');
    const drill = (t: string) => fetch('http://127.0.0.1:18797/drill/drop-feed', { method: 'POST', headers: { 'x-zeroed-drill-token': t }, body: JSON.stringify({ feed: 'pumpportal', ms: 500 }) });
    expect((await drill('wrong')).status).toBe(403);
    expect((await drill(token)).status).toBe(202);
    const pp = h.sources.find((s) => s.name === 'pumpportal')!;
    expect(pp.stops).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(pp.starts).toBe(2);
    expect(lines(h.stateDir).filter((l) => l['kind'] === 'feed' && l['feed'] === 'pumpportal').map((l) => l['connected'])).toEqual([false, true]);
    await h.worker.stop();
  });

  it('answers 404 to the drill when drills are off', async () => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18798', ZEROED_DRILLS: 'off' } });
    await h.worker.start();
    const r = await fetch('http://127.0.0.1:18798/drill/drop-feed', { method: 'POST', body: '{}' });
    expect(r.status).toBe(404);
    await h.worker.stop();
  });
});

describe('the reservation goes through the ledger with the snapshot\'s account version (RISK-1, LEDGER-1c)', () => {
  const at = { slot: 1n, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: T };
  const decision = (seq: number, action: BookEvent, reasons: string[]): LogRecord =>
    ({ type: 'decision', seq, at, eventId: `e${seq}`, inputs: [], action, reasons, result: 'applied', effects: [] }) as LogRecord;
  const entry = (n: number, version: bigint, amount = 20_000_000n): LogRecord[] => {
    const m = toMint(MINT);
    const id = intentId(`en:${MINT}:${n}`);
    const req = { reservationId: `r:${MINT}:${n}`, intentId: id, amount: String(amount), maxHeld: '100000000', maxCount: 5, accountVersion: String(version) };
    return [
      decision(n * 10, { type: 'propose_entry', intent: { id, key: entryKey(m, `t.${n}`), purpose: 'entry', side: 'buy', mint: m, venue: 'pumpswap', positionId: positionId(`p:${MINT}:${n}`), spend: 13_000_000n as Lamports } }, ['enter']),
      decision(n * 10 + 1, { type: 'intent', intentId: id, event: { type: 'mark_eligible' } }, ['gates passed']),
      decision(n * 10 + 2, { type: 'intent', intentId: id, event: { type: 'approve_risk' } }, ['risk approved', `${RESERVE_PREFIX}${JSON.stringify(req)}`]),
    ];
  };

  const deskOn = (ledger: ReturnType<typeof openLedger>, reports: BookEvent[], diverged: string[] = []) => new Desk({
    ledger, config: { maxOpenPositions: 5 }, restored: emptyBook({ maxOpenPositions: 5 }),
    journal: () => undefined, report: (e) => {
      reports.push(e);
      return `world#${reports.length}`;
    },
    accountChanged: () => undefined, intentsChanged: () => undefined, reserved: () => undefined, filled: () => undefined,
    diverged: (r) => void diverged.push(r),
  });

  it('a world event the engine applied but the ledger refuses is a divergence, reported once per event', () => {
    const ledger = openLedger(join(tempState(), 'ledger.sqlite'), 'paper');
    const diverged: string[] = [];
    const desk = deskOn(ledger, [], diverged);
    desk.consume([{ type: 'world', seq: 1, at, eventId: 'world#x', event: { type: 'intent', intentId: intentId('unknown'), event: { type: 'cancel' } }, result: 'applied', effects: [] } as LogRecord]);
    expect(desk.ledgerRefusals).toBe(1);
    expect(diverged).toHaveLength(1);
    expect(diverged[0]).toMatch(/^ledger refused intent/);
    ledger.close();
  });
  it('a restored event the engine refuses is a divergence; a late world answer it refuses is not', () => {
    const ledger = openLedger(join(tempState(), 'ledger.sqlite'), 'paper');
    const diverged: string[] = [];
    const journal: Record<string, unknown>[] = [];
    const desk = new Desk({
      ledger, config: { maxOpenPositions: 5 }, restored: emptyBook({ maxOpenPositions: 5 }),
      journal: (_kind, f) => void journal.push(f), report: () => 'world#unused',
      accountChanged: () => undefined, intentsChanged: () => undefined, reserved: () => undefined, filled: () => undefined,
      diverged: (r) => void diverged.push(r),
    });
    const refused = (eventId: string) => ({ type: 'world', seq: 1, at, eventId, event: { type: 'intent', intentId: intentId('x'), event: { type: 'prepare' } }, result: 'illegal', reason: 'prepare needs reserved exposure (from cancelled)', effects: [] }) as unknown as LogRecord;
    // The ledger already holds this one (the restore marked it): the engine refusing it leaves the two books apart.
    desk.written('world#restored');
    desk.consume([refused('world#restored')]);
    expect(diverged).toEqual(['world event intent refused: prepare needs reserved exposure (from cancelled)']);
    // A paper answer for an intent the engine already finished: refused, journaled, and the books still agree.
    desk.consume([refused('world#late')]);
    expect(diverged).toHaveLength(1);
    expect(journal.filter((f) => f['action'] === 'world_refused').map((f) => f['event'])).toEqual(['world#restored', 'world#late']);
    expect(desk.illegal).toBe(2);
    ledger.close();
  });

  /** Another account change between the snapshot and the reservation: a reservation stored by someone else. */
  const changeAccount = (ledger: ReturnType<typeof openLedger>) => {
    const m = toMint(MINT);
    const id = intentId('other');
    let book = emptyBook({ maxOpenPositions: 5 });
    for (const e of [
      { type: 'propose_entry', intent: { id, key: entryKey(m, 'other'), purpose: 'entry', side: 'buy', mint: m, venue: 'pumpswap', positionId: positionId('p:other'), spend: 1_000n as Lamports } },
      { type: 'intent', intentId: id, event: { type: 'mark_eligible' } },
      { type: 'intent', intentId: id, event: { type: 'approve_risk' } },
      { type: 'intent', intentId: id, event: { type: 'reserve_exposure', reservation: { id: 'r:other', intentId: id, amount: 2_000n, status: 'held' } } },
    ] as BookEvent[]) book = ledger.recordBookEvent(book, e, { ts: T, limits: { maxHeld: 10n ** 12n as Lamports, maxCount: 10 }, accountVersion: ledger.accountVersion() }).book;
  };

  it('a reservation decided on a snapshot the account has moved past is refused as stale and goes back as a reject', () => {
    const ledger = openLedger(join(tempState(), 'ledger.sqlite'), 'paper');
    const reports: BookEvent[] = [];
    const desk = deskOn(ledger, reports);
    const v = ledger.accountVersion();
    const [propose, mark, approve] = entry(1, v);
    desk.consume([propose!, mark!]);
    changeAccount(ledger);
    desk.consume([approve!]);
    expect(reports).toHaveLength(1);
    const reject = reports[0]!;
    expect(reject.type === 'intent' && reject.event.type === 'reject' && reject.event.reason).toMatch(/re-evaluate: stale_snapshot/);
    expect(ledger.heldReservations().map((r) => r.intentId)).toEqual(['other']);
    expect(desk.ledgerRefusals).toBe(0);
    ledger.close();
  });

  it('the strategy re-evaluates: a new decision on the current snapshot is stored (never a blind retry of the old one)', () => {
    const ledger = openLedger(join(tempState(), 'ledger.sqlite'), 'paper');
    const reports: BookEvent[] = [];
    const desk = deskOn(ledger, reports);
    const [propose, mark, approve] = entry(1, ledger.accountVersion());
    desk.consume([propose!, mark!]);
    changeAccount(ledger);
    desk.consume([approve!]);
    // The engine applies the reject (a world event), then the strategy decides again on the fresh snapshot.
    desk.consume([{ type: 'world', seq: 99, at, eventId: 'world#1', event: reports[0]!, result: 'applied', effects: [] } as LogRecord]);
    desk.consume(entry(2, ledger.accountVersion()));
    expect(reports.map((e) => (e.type === 'intent' ? e.event.type : e.type))).toEqual(['reject', 'reserve_exposure']);
    expect(ledger.heldReservations().map((r) => r.intentId).sort()).toEqual([`en:${MINT}:2`, 'other']);
    expect(desk.ledgerRefusals).toBe(0);
    ledger.close();
  });
});

describe('the month\'s credit use survives a restart (FEED-1: the 70% halt is never reset)', () => {
  it('is saved within a second of a spend and loaded at the next start', async () => {
    const dir = tempState();
    const timers = virtualTimers(T);
    const book = new CreditBook(dir, timers);
    const s = book.scheduler(HELIUS_FREE);
    s.meter(700_000);
    await new Promise((r) => setTimeout(r, 20));
    const again = new CreditBook(dir, virtualTimers(T + 5_000)).scheduler(HELIUS_FREE);
    expect(again.status().creditsUsed).toBe(700_000);
    // 70% of the month's budget: only P0 runs, after the restart too.
    expect(again.halted).toBe(true);
  });

  it('a new month starts from zero', () => {
    const dir = tempState();
    writeFileSync(join(dir, 'credits.json'), JSON.stringify({ month: '2026-09', used: { helius: 900_000 } }));
    expect(new CreditBook(dir, virtualTimers(T)).scheduler(HELIUS_FREE).status().creditsUsed).toBe(0);
  });
});

interface Case { readonly name: string; readonly mint: string; readonly transactions: readonly (RpcTransactionBase64 & { readonly signature: string })[] }
const RUGS = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rug-replay.json'), 'utf8')) as { cases: Case[] };

describe('deployer index and rug labeller wiring (GATE-1b, RUG-1), and the confirmed create of a shortlisted mint', () => {
  it('every released event reaches the labeller; its label reaches the deployer index the gates read', async () => {
    const c = RUGS.cases.find((x) => x.name === 'rug')!;
    const first = recordFromRpc(c.transactions[0]!.signature, c.transactions[0]!, null);
    const fetched: string[] = [];
    const h = makeWorker({ timers: virtualTimers((first.blockTime ?? 0) * 1000), fetched });
    await h.worker.reconcile();
    for (const t of c.transactions) {
      const rec = recordFromRpc(t.signature, t, null);
      h.timers.set((rec.blockTime ?? 0) * 1000);
      h.worker.feed.ingest('helius', { type: 'slot', slot: rec.slot + 3n, parent: rec.slot + 2n, root: null }, { receivedAt: h.timers.now() });
      h.worker.feed.ingest('helius', { type: 'logs', signature: t.signature, slot: rec.slot, err: rec.err, via: 'pump', logs: rec.logMessages ?? [] }, { receivedAt: h.timers.now() });
      h.worker.step();
    }
    await new Market(h).run(3_000);
    const creator = 'GaMPRt9yhnhRAB134imiwkmXAtVYkcTtZFzF1nBeqw6H';
    const now = { ...GENESIS, slot: 10n ** 12n, receivedAt: h.timers.now() };
    expect(h.worker.strategy.deployers.factFor(creator, now, 0).rugs.map((r) => r.mint)).toEqual([c.mint]);

    // Item 9: a migration names the mint a candidate; the worker fetches its confirmed create (seen on the creates stream).
    const m = new Market(h);
    m.slot(slotAt(h.timers.now()) + 10n ** 9n);
    m.fact(migrationKey(c.mint), { obs: { provider: 'test', slot: null, receivedAt: h.timers.now(), quality: [], commitment: 'confirmed' }, graduatedAtMs: h.timers.now(), migratedAtMs: h.timers.now(), pool: c.mint, quoteAtMigration: 1n, price: { quote: 1n, base: 1n } });
    await m.run(3_000);
    expect(fetched).toEqual([c.transactions[0]!.signature]);
    await h.worker.stop();
  });
});

describe('a cut trade log on a rug-covered stream (RUG-1 wiring rule)', () => {
  const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const SIG = '5'.repeat(88);
  const run = async (found: boolean, covered: boolean) => {
    const fetched: string[] = [];
    const h = makeWorker({ fetched, found });
    await h.worker.reconcile();
    const m = new Market(h);
    m.slot(1_000n);
    if (covered) m.offchain('coverage:rugs:start', { fromSlot: 900n, via: `logs:${PUMP}` });
    h.worker.feed.ingest('helius', { type: 'logs', signature: SIG, slot: 1_001n, err: null, via: `logs:${PUMP}`, logs: [`Program ${PUMP} invoke [1]`, 'Log truncated'] }, { receivedAt: h.timers.now() });
    await m.run(3_000, 200, () => m.slot());
    await m.run(3_000, 200, () => m.slot());
    const gaps = rowsOf(h.stateDir, 'coverage:rugs:gap');
    await h.worker.stop();
    return { fetched, gaps };
  };
  const rowsOf = (dir: string, key: string): unknown[] => {
    const rec = join(dir, 'recorder');
    // The frames still in the open recorder files (flushed every step).
    const out: unknown[] = [];
    for (const boot of readdirSync(rec)) {
      for (const day of readdirSync(join(rec, boot, 'days'))) {
        for (const f of readdirSync(join(rec, boot, 'days', day))) {
          if (!f.startsWith('frames-') || !f.endsWith('.jsonl')) continue;
          for (const l of readFileSync(join(rec, boot, 'days', day, f), 'utf8').split('\n')) if (l.includes(`"key":"${key}"`)) out.push(JSON.parse(l));
        }
      }
    }
    return out;
  };

  it('is fetched, and when its transaction is not found it becomes a bounded coverage:rugs:gap at its slot', async () => {
    const r = await run(false, true);
    expect(r.fetched).toEqual([SIG]);
    expect(r.gaps).toHaveLength(1);
    expect(JSON.stringify(r.gaps[0])).toContain('"fromSlot":{"$n":"1001"}');
  });

  it('a fetched transaction closes the hole (no gap), and a stream without rug coverage is left alone', async () => {
    expect((await run(true, true)).gaps).toEqual([]);
    const off = await run(false, false);
    expect(off.fetched).toEqual([]);
    expect(off.gaps).toEqual([]);
  });
});

describe('the FactSource hook (FACTS-1 plugs in here)', () => {
  it('starts each producer after the reconcile and the seed, before the feeds; its facts reach the engine as of receipt', async () => {
    let ctx: FactContext | null = null;
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18796' }, facts: [{ name: 'test', start: (c) => void (ctx = c), stop: () => undefined }] });
    expect(await h.worker.start()).toEqual({ ok: true });
    expect(ctx).not.toBeNull();
    const c = ctx as unknown as FactContext;
    expect(c.schedulers.helius.spec.provider).toBe('helius');
    c.sink.fact(migrationKey(MINT), { obs: { provider: 'test', slot: null, receivedAt: c.sink.now(), quality: [], commitment: 'confirmed' }, graduatedAtMs: T, migratedAtMs: T, pool: MINT, quoteAtMigration: 1n, price: { quote: 1n, base: 1n } });
    await new Market(h).run(3_000);
    expect(c.watched().has(MINT)).toBe(true);
    await h.worker.stop();
  });
});

describe('FEED-1 off-chain ids', () => {
  it('world reports put on the feed at the same moment are released in arrival order', () => {
    const feed = new LiveFeed(DEFAULT_LIVE_FEED);
    const ids: string[] = [];
    for (let k = 0; k < 12; k++) ids.push(`world#${String(feed.ingest('worker', { type: 'world', event: { type: 'tick', blockHeight: BigInt(k) } }, { receivedAt: 1_000 }).seq).padStart(12, '0')}`);
    feed.advance(10_000);
    const out: string[] = [];
    for (let e = feed.next(); e !== null; e = feed.next()) out.push(e.id);
    expect(out).toEqual(ids);
  });
});

describe('no key in any output (review of f679188, item 8)', () => {
  it('redacts credential values and key-shaped URL parts', () => {
    setSecretValues(['hk-1234567890abcdef', 'short', null]);
    expect(redact('GET https://mainnet.helius-rpc.com/?api-key=hk-1234567890abcdef failed')).toBe('GET https://mainnet.helius-rpc.com/?api-key=[redacted] failed');
    expect(redact('wss://x.test/?api-key=anotherkey99&x=1')).toBe('wss://x.test/?api-key=[redacted]&x=1');
    expect(redact('https://solana-mainnet.g.alchemy.com/v2/abcDEF123456/x')).toBe('https://solana-mainnet.g.alchemy.com/v2/[redacted]/x');
    expect(redact('https://api.telegram.org/bot12345:AAbb-cc_dd/sendMessage')).toBe('https://api.telegram.org/bot[redacted]/sendMessage');
    expect(redact('error: token hk-1234567890abcdef refused')).toBe('error: token [redacted] refused');
    expect(redact('short words stay')).toBe('short words stay');
    setSecretValues([]);
  });

  it('the journal never holds a credential, whatever a message carries', () => {
    setSecretValues(['hk-1234567890abcdef']);
    const dir = tempState();
    const j = new Journal(join(dir, 'journal.jsonl'), 'b', () => T);
    j.write('decision', { reasons: ['seed failed: fetch https://rpc.test/?api-key=hk-1234567890abcdef'], detail: 'hk-1234567890abcdef' });
    const text = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
    expect(text).not.toContain('hk-1234567890abcdef');
    expect(text).toContain('[redacted]');
    setSecretValues([]);
  });

  it('the entry prints only through the redacting log and fail', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(src.match(/console\.(log|error|warn|info)\(/g)).toEqual(['console.log(', 'console.error(']);
    expect(src).toContain('console.log(redact(line))');
    expect(src).toContain('console.error(redact(line))');
  });
});

describe('the paper wallet\'s setup rent is an account cost (risk review of #48, item 7; RISK-1b costs)', () => {
  const rent = (128n + 137n) * 5_080n;
  const bankroll = 20_000_000n as MicroUsd;
  const price = 150_250_000n as MicroUsd;

  it('right after setup there is one cost of the rent at the setup SOL price, rounded up, and no closed trade', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const account = new PaperAccount(accountFile(dir), bankroll, T - 60_000, rent);
    account.price(price, T - 1_000);
    const opening = microUsdToLamports(bankroll, price, 'floor');
    expect(account.state.walletLamports).toBe(opening - rent);
    const fact = account.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, price, T);
    const cost = lamportsToMicroUsd(rent as Lamports, price, 'ceil');
    expect(fact.history.costs).toEqual([{ atMs: T - 1_000, amount: cost, kind: 'wallet_setup' }]);
    expect(fact.history.closedTrades).toEqual([]);
    expect(fact.oneTimeRent).toBe(0n);
    // Paid once: a later price does not charge it again.
    account.price(160_000_000n as MicroUsd, T);
    expect(account.state.walletLamports).toBe(opening - rent);
    expect(account.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, price, T).history.costs).toHaveLength(1);
    ledger.close();
  });

  it('a first real losing trade after setup causes no R8 cooldown (the setup is not a trade)', () => {
    const dir = tempState();
    const ledger = openLedger(join(dir, 'ledger.sqlite'), 'paper');
    const file = accountFile(dir);
    const account = new PaperAccount(file, bankroll, T - 3_600_000, rent);
    account.price(price, T - 3_000_000);
    // One closed losing trade, as the paper fills would book it.
    file.write({ ...account.state, trades: [{ positionId: 'p:x:1', mint: MINT, openedAtMs: T - 600_000, notional: 2_000_000n as MicroUsd, closedAtMs: T - 60_000, netLamports: -100_000n, netPnl: -15_000n as MicroUsd, stoppedOut: true, booked: -100_000n }] });
    const reloaded = new PaperAccount(file, bankroll, T, rent);
    const fact = reloaded.fact(ledger, emptyBook({ maxOpenPositions: 5 }), NO_LATCHES, price, T);
    expect(fact.history.closedTrades).toHaveLength(1);
    const session = startSession(TRIAL_POLICY);
    const r = evaluateExit({
      session, mode: 'paper', clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T }) }, account: fact.history, latches: NO_LATCHES,
      market: { solPrice: { value: price, atMs: T }, solBalance: fact.solBalance, regime: 'unknown' },
    });
    expect(r.tripped.map((x) => x.code)).not.toContain('loss_cooldown');
    ledger.close();
  });
});

