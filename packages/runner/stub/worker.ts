// Stub worker: implements the worker process contract (docs/ARCHITECTURE.md §12.4) with synthetic feeds and
// synthetic paper trades, so RUN-1's runner, drills and evidence can be built and tested before WORKER-1 exists.
// No network: feeds are timers, nothing is fetched or sent. It reports `stub: true`, and a run with it never passes.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { DEFAULT_HEALTH_ADDR, EXIT, isLoopback, SECRET_NAMES, STATE_FILES, type FeedHealth, type Health, type JournalKind, type QuotaStatus } from '../src/contract.ts';

const env = process.env;
const fail = (code: number, msg: string): never => {
  console.error(msg);
  process.exit(code);
};

const stateDir = env['STATE_DIRECTORY'] ?? env['ZEROED_STATE_DIR'] ?? fail(EXIT.config, 'no state directory (STATE_DIRECTORY or ZEROED_STATE_DIR)');
// Unset is refused too: the mode is always stated, never assumed.
if (env['ZEROED_MODE'] !== 'paper') fail(EXIT.config, 'refused: ZEROED_MODE must be paper');
const healthAddr = env['ZEROED_HEALTH_ADDR'] ?? DEFAULT_HEALTH_ADDR;
if (!isLoopback(healthAddr)) fail(EXIT.config, 'refused: the health address must be loopback');
const recorderOn = env['ZEROED_RECORDER'] === 'on';
const simulationOn = env['ZEROED_SIMULATE'] === 'on';
const drillsOn = env['ZEROED_DRILLS'] === 'on';
const tickMs = Number(env['ZEROED_STUB_TICK_MS'] ?? 1000);
const cycleMs = Number(env['ZEROED_STUB_CYCLE_MS'] ?? 60_000);

const credDir = env['CREDENTIALS_DIRECTORY'];
const credentials = SECRET_NAMES.filter((n) => (credDir ? existsSync(join(credDir, n.toLowerCase())) : Boolean(env[n])));

let gitSha = env['ZEROED_GIT_SHA'] ?? 'unknown';
if (gitSha === 'unknown') {
  try {
    gitSha = basename(readlinkSync('/opt/zeroed/current'));
  } catch {}
}

mkdirSync(join(stateDir, STATE_FILES.recorder), { recursive: true });
const journalPath = join(stateDir, STATE_FILES.journal);
const statePath = join(stateDir, 'stub-state.json');

interface StubState {
  trades: number;
  /** `exitPlanned`: past 40% of the cycle the exit is planned (a pending exit a restart must keep). */
  position: { trade: string; openedAt: number; universe: string; exitPlanned?: boolean } | null;
  /** Set by --reconcile when it found no state at all: the start that follows reports `source: chain`. */
  fromChain?: boolean;
  /** An intent that was being worked on when the process died: settled by reconcile. */
  intent: { trade: string; leg: 'entry' | 'exit' } | null;
  /** Set by --reconcile (ExecStartPre) when it settled an intent, so the start that follows journals its exposure. */
  settledIntent?: { trade: string; leg: 'entry' | 'exit' } | null;
}
const loadState = (): StubState => {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as StubState;
  } catch {
    return { trades: 0, position: null, intent: null };
  }
};
const saveState = (s: StubState): void => {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(s));
  renameSync(`${statePath}.tmp`, statePath);
};

// Test hook: a reconcile that cannot settle its intents exits 3, never serves `reconciled: false`.
const reconcileFails = env['ZEROED_STUB_FAIL_RECONCILE'] === '1';

// --reconcile-only (the host-loss tabletop): cold-start on this state dir, reconcile, report, and send nothing:
// no entries, no exits, no heartbeat. It runs beside the live worker until it is stopped.
const reconcileOnly = process.argv.includes('--reconcile-only');

if (process.argv.includes('--reconcile')) {
  if (reconcileFails) fail(EXIT.reconcileFailed, 'Reconcile: intents left unresolved.');
  // ExecStartPre step: settle what a crash left behind, then report open intents for the host's update gate.
  // No state on disk (host lost, no backup): rebuild from chain. A paper position is not on chain, so nothing comes back.
  const found = existsSync(statePath);
  const s = loadState();
  if (!found) s.fromChain = true;
  s.settledIntent = s.intent;
  s.intent = null;
  saveState(s);
  writeFileSync(join(stateDir, STATE_FILES.openIntents), '0\n');
  console.log(`Reconcile: 0 open intents, ${credentials.length} of ${SECRET_NAMES.length} credentials present.`);
  process.exit(EXIT.clean);
}

// Journal: repair a torn last line left by a kill, then continue the sequence.
let seq = 0;
let repaired = false;
let lastTs: string | null = null;
if (existsSync(journalPath)) {
  const text = readFileSync(journalPath, 'utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let keep = text.length;
  const last = lines[lines.length - 1];
  if (last !== undefined) {
    try {
      JSON.parse(last);
    } catch {
      keep = text.length - last.length - (text.endsWith('\n') ? 1 : 0);
      lines.pop();
      repaired = true;
    }
  }
  if (repaired) truncateSync(journalPath, Buffer.byteLength(text.slice(0, keep)));
  const lastGood = lines[lines.length - 1];
  if (lastGood !== undefined) ({ seq, ts: lastTs } = JSON.parse(lastGood) as { seq: number; ts: string });
}
const boot = `${Date.now().toString(36)}-${process.pid}`;
const journal = (kind: JournalKind, fields: Record<string, unknown> = {}): void => {
  seq += 1;
  appendFileSync(journalPath, `${JSON.stringify({ seq, ts: new Date().toISOString(), boot, kind, ...fields })}\n`);
};
rmSync(join(stateDir, STATE_FILES.cleanStop), { force: true });
journal('start', {
  git_sha: gitSha, run_id: env['ZEROED_RUN_ID'] ?? null, label: env['ZEROED_RUN_LABEL'] ?? null, recorder: recorderOn, simulation: simulationOn, stub: true,
  entry_rule: env['ZEROED_STRATEGY'] ?? 'none', paper_edge_ppm: env['ZEROED_PAPER_EDGE_PPM'] ?? null, s0_salt: env['ZEROED_STUB_SALT'] ?? null,
});
if (repaired) journal('journal_repair', { detail: 'torn last line removed' });

if (reconcileFails) {
  journal('reconcile', { ok: false, reasons: ['stub: intents left unresolved'] });
  fail(EXIT.reconcileFailed, 'Reconcile failed: exiting before any entry.');
}
const stateFound = existsSync(statePath);
const state = loadState();
const fromChain = !stateFound || state.fromChain === true;
const settled = state.intent ?? state.settledIntent ?? null;
state.intent = null;
state.settledIntent = null;
delete state.fromChain;
saveState(state);
writeFileSync(join(stateDir, STATE_FILES.openIntents), '0\n');
journal('reconcile', { ok: true, settled: settled ? `${settled.leg} of ${settled.trade}` : null, open_position: state.position?.trade ?? null });
const pendingExits = (): string[] => [
  ...new Set([...(state.position?.exitPlanned ? [state.position.trade] : []), ...(state.intent?.leg === 'exit' ? [state.intent.trade] : [])]),
];
journal('recovered', {
  source: fromChain ? 'chain' : 'state',
  pending_exits: [...pendingExits(), ...(settled?.leg === 'exit' && !pendingExits().includes(settled.trade) ? [settled.trade] : [])],
  positions: state.position ? [{ trade: state.position.trade, universe: state.position.universe }] : [],
});
// Back with a position open: the down window's worst move, as WORKER-1 rebuilds it from chain history (stub: flat).
// One line per trade that was open or in flight at the kill (the stub's market is flat: 0 bps).
if (lastTs !== null) {
  for (const trade of new Set([...(state.position ? [state.position.trade] : []), ...(settled ? [settled.trade] : [])])) {
    journal('exposure', { trade, from_ts: lastTs, to_ts: new Date().toISOString(), worst_move_bps: 0 });
  }
}
const bootAt = Date.now();
// Exit capable a little after reconcile (test hook), so the runner's exposure measure has a window to see.
const exitDelayMs = Number(env['ZEROED_STUB_EXIT_DELAY_MS'] ?? 0);
const creditsPerS = Number(env['ZEROED_STUB_CREDITS_PER_S'] ?? 0.1);
const lookupCounts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const STREAM: Record<string, string> = { pumpportal: 'creates', 'helius-ws': 'trades', 'alchemy-ws': 'rugs' };

// Feeds.
const FEEDS: Record<string, { critical: boolean }> = { pumpportal: { critical: true }, 'helius-ws': { critical: true }, 'alchemy-ws': { critical: false } };
const feeds = new Map(Object.keys(FEEDS).map((n) => [n, { last: null as number | null, downUntil: 0, downFrom: 0, gapId: '' }]));
const recorderPath = join(stateDir, STATE_FILES.recorder, `${boot}.jsonl`);
let slot = 0;
let halted = false;
const haltReasons = (now: number): string[] =>
  [...feeds].filter(([n, f]) => FEEDS[n]!.critical && (f.downUntil > now || f.last === null || now - f.last > 5 * tickMs)).map(([n]) => `feed ${n} stale`);

// TEST-2's DryRunRecord shape, bigints as strings; synthetic numbers that pass item 4's bounds.
const stubSimulation = (): Record<string, unknown> => ({
  outcome: 'simulated', success: true, error: null, standIn: null, quotedOut: '1000000', simulatedOut: '1000100',
  amountErrorE4: 100, quoteAgeSlots: '2', rentDeclared: '0', rentPaid: '0', balancesFrom: 'simulation',
});

// Test hook: open the first trade on the first tick instead of after one cycle.
let tradeTimer = env['ZEROED_STUB_OPEN_AT_START'] === '1' ? cycleMs - tickMs : 0;
let exitCapableJournaled = false;
const tick = (): void => {
  const now = Date.now();
  slot += 1;
  for (const [name, f] of feeds) {
    if (f.downUntil > now) continue;
    if (f.downUntil !== 0) {
      journal('coverage_gap', { stream: STREAM[name], gap_id: f.gapId, from_ts: new Date(f.downFrom).toISOString(), to_ts: new Date(now).toISOString(), reason: 'disconnect' });
      f.downUntil = 0;
      journal('feed', { feed: name, connected: true });
    }
    lookupCounts[slot % 3]! += 1;
    f.last = now;
    if (recorderOn) appendFileSync(recorderPath, `${JSON.stringify({ source: name, receivedAt: now, slot, kind: 'stub' })}\n`);
  }
  const reasons = haltReasons(now);
  if (reasons.length && !halted) {
    halted = true;
    journal('halt', { reasons });
  } else if (!reasons.length && halted) {
    halted = false;
    journal('resume', { reasons: ['all critical feeds fresh'] });
  }
  if (!exitCapableJournaled && now - bootAt >= exitDelayMs && rpcDownUntil <= now) {
    exitCapableJournaled = true;
    journal('exit_capable', {});
  }
  if (reconcileOnly) return;
  // Paper trading: open for 60% of each cycle, flat for the rest. Exits run even while entries are halted.
  tradeTimer += tickMs;
  const phase = tradeTimer % cycleMs;
  if (!state.position && phase < tickMs) {
    if (halted) {
      journal('decision', {
        action: 'skip',
        reasons: ['entries halted: ' + haltReasons(now).join(', ')],
        gate_reasons: [{ gate: 'H16', code: 'not-covered', detail: 'stub: discovery stream down' }],
      });
    } else {
      state.trades += 1;
      const trade = `${boot}-t${state.trades}`;
      state.intent = { trade, leg: 'entry' };
      saveState(state);
      journal('decision', { action: 'enter', trade, reasons: ['stub: synthetic setup'] });
      if (simulationOn) journal('simulation', { trade, leg: 'entry', ...stubSimulation() });
      state.position = { trade, openedAt: now, universe: 'U2' };
      state.intent = null;
      saveState(state);
      journal('entry', { trade, position: 'open', universe: 'U2', reasons: ['stub: synthetic setup'] });
    }
  } else if (state.position && !state.position.exitPlanned && phase >= cycleMs * 0.4 && phase < cycleMs * 0.6) {
    state.position.exitPlanned = true;
    saveState(state);
  } else if (state.position && phase >= cycleMs * 0.6) {
    const trade = state.position.trade;
    state.intent = { trade, leg: 'exit' };
    saveState(state);
    if (simulationOn) journal('simulation', { trade, leg: 'exit', ...stubSimulation() });
    state.position = null;
    state.intent = null;
    saveState(state);
    journal('exit', { trade, position: 'closed', reasons: ['stub: hold time reached'] });
  }
};

let rpcDownUntil = 0;
const dropFeed = (name: string, ms: number): void => {
  const f = feeds.get(name)!;
  f.downUntil = Date.now() + ms;
  f.downFrom = Date.now();
  f.gapId = `${boot}-${name}-${f.downFrom}`;
  journal('coverage_gap', { stream: STREAM[name], gap_id: f.gapId, from_ts: new Date(f.downFrom).toISOString(), to_ts: null, reason: 'disconnect' });
  journal('feed', { feed: name, connected: false, cause: 'drill' });
};

const drillToken = randomBytes(16).toString('hex');
if (drillsOn) writeFileSync(join(stateDir, STATE_FILES.drillToken), drillToken, { mode: 0o600 });

const quota = (now: number): QuotaStatus[] => {
  // Whole credits (the contract), split across classes with the remainder on P1.
  const used = Math.floor(((now - bootAt) / 1000) * creditsPerS);
  const p0 = Math.floor(used / 10);
  const p2 = Math.floor((used * 3) / 10);
  const p3 = Math.floor(used / 5);
  const cls: [number, number, number, number] = [p0, used - p0 - p2 - p3, p2, p3];
  const zero: [number, number, number, number] = [0, 0, 0, 0];
  return [
    { provider: 'helius', credits_used: used, credits_by_class: cls, monthly_credits: 1_000_000, granted: [1, 1, 1, 1], shed: zero, halted: false },
    { provider: 'alchemy', credits_used: 0, credits_by_class: zero, monthly_credits: 30_000_000, granted: zero, shed: zero, halted: false },
    { provider: 'jupiter', credits_used: 0, credits_by_class: zero, monthly_credits: null, granted: zero, shed: zero, halted: false },
  ];
};

const health = (): Health => {
  const now = Date.now();
  const feedHealth: Record<string, FeedHealth> = {};
  const ages: Record<string, number | null> = {};
  for (const [n, f] of feeds) {
    const age = f.last === null ? null : now - f.last;
    ages[n] = age;
    feedHealth[n] = { connected: f.downUntil <= now, age_ms: age, critical: FEEDS[n]!.critical, dropped_by_drill: f.downUntil > now };
  }
  return {
    seq,
    ts: now,
    git_sha: gitSha,
    policy_version: 'stub',
    last_processed_slot: slot,
    feed_ages_ms: ages,
    open_position: state.position ? { trade: state.position.trade, mint: 'stub', qty: '1', entry: '1', stop: '0.9', mark: '1', mark_slot: slot, mark_ts: now, universe: state.position.universe } : null,
    open_positions: state.position ? [{ trade: state.position.trade, mint: 'stub', qty: '1', entry: '1', stop: '0.9', mark: '1', mark_slot: slot, mark_ts: now, universe: state.position.universe }] : [],
    unresolved_intents: { count: state.intent ? 1 : 0, oldest_age_s: state.intent ? 0 : null, trades: state.intent ? [state.intent.trade] : [] },
    signer: 'none',
    lease_epoch: null,
    sol_reserve: null,
    paused: false,
    boot,
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    rss_bytes: process.memoryUsage().rss,
    mode: 'paper',
    recorder: recorderOn ? 'on' : 'off',
    simulation: simulationOn ? 'on' : 'off',
    reconciled: true,
    // Never before its journal line: the runner times a reboot from that line.
    exit_capable: exitCapableJournaled && now - bootAt >= exitDelayMs && rpcDownUntil <= now,
    // Test hook: a reply whose pending exits are not ids (the runner must not trust it at a kill).
    pending_exits: env['ZEROED_STUB_BAD_PENDING'] === '1' ? [''] : pendingExits(),
    quota: quota(now),
    lookups: { counts: lookupCounts },
    entries_halted: halted,
    halt_reasons: haltReasons(now),
    critical: [],
    feeds: feedHealth,
    journal_seq: seq,
    signing_key: false,
    stub: true,
  };
};

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health()));
    return;
  }
  if (drillsOn && req.method === 'POST' && req.url === '/drill/drop-feed') {
    if (req.headers['x-zeroed-drill-token'] !== drillToken) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      const { feed, ms } = JSON.parse(body || '{}') as { feed?: string; ms?: number };
      const f = feed === undefined ? undefined : feeds.get(feed);
      if (!f || !(typeof ms === 'number' && ms > 0)) {
        res.writeHead(400).end();
        return;
      }
      dropFeed(feed!, ms);
      res.writeHead(202).end();
    });
    return;
  }
  // Every provider lost at once: all feeds down, and no exit can be quoted or landed until they are back.
  if (drillsOn && req.method === 'POST' && req.url === '/drill/drop-rpc') {
    if (req.headers['x-zeroed-drill-token'] !== drillToken) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      const { ms } = JSON.parse(body || '{}') as { ms?: number };
      if (!(typeof ms === 'number' && ms > 0)) {
        res.writeHead(400).end();
        return;
      }
      rpcDownUntil = Date.now() + ms;
      for (const name of feeds.keys()) dropFeed(name, ms);
      res.writeHead(202).end();
    });
    return;
  }
  res.writeHead(404).end();
});
const [host, port] = [healthAddr.slice(0, healthAddr.lastIndexOf(':')).replace(/^\[|\]$/g, ''), Number(healthAddr.slice(healthAddr.lastIndexOf(':') + 1))];
server.listen(port, host);
server.on('error', (e) => fail(EXIT.crash, `health server: ${e.message}`));

const timer = setInterval(tick, tickMs);
console.log(`Stub worker up: boot ${boot}, ${credentials.length} of ${SECRET_NAMES.length} credentials, recorder ${recorderOn ? 'on' : 'off'}, simulation ${simulationOn ? 'on' : 'off'}.`);

const stop = (): void => {
  clearInterval(timer);
  journal('stop', { open_position: state.position?.trade ?? null });
  writeFileSync(join(stateDir, STATE_FILES.cleanStop), new Date().toISOString());
  server.close();
  process.exit(EXIT.clean);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
