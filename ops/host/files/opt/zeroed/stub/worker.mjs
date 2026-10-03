// Stand-in for the worker until WORKER-1 lands. It exercises everything the host gives the real worker:
// encrypted credentials (it counts them, never prints them), the state directory with a SQLite ledger
// (so the hourly backup has real data), the signer socket, and the HMAC-signed heartbeat to the watchdog.
// `--reconcile` is the ExecStartPre step: the real worker settles open intents against the chain there.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const credDir = process.env.CREDENTIALS_DIRECTORY ?? '';
const stateDir = process.env.STATE_DIRECTORY ?? '/var/lib/zeroed';
const watchdog = (process.env.WATCHDOG_URL ?? '').replace(/\/$/, '');
const intervalMs = Number(process.env.ZEROED_HEARTBEAT_MS ?? 20_000);
const NAMES = ['helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token', 'telegram_chat_id'];

const loaded = credDir ? NAMES.filter((n) => existsSync(join(credDir, n))) : [];
const db = new DatabaseSync(join(stateDir, 'ledger.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
db.exec('CREATE TABLE IF NOT EXISTS host_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT)');
const record = db.prepare('INSERT INTO host_events (ts, kind, detail) VALUES (?, ?, ?)');
const event = (kind, detail = null) => record.run(new Date().toISOString(), kind, detail);

let gitSha = 'none';
try {
  gitSha = basename(readlinkSync('/opt/zeroed/current'));
} catch {}

if (process.argv.includes('--reconcile')) {
  const ok = loaded.length === NAMES.length;
  // Contract with the host's update check: the number of open intents after reconcile.
  writeFileSync(join(stateDir, 'open_intents'), '0\n');
  event('reconcile', `stub: 0 open intents, ${ok ? 'ok' : 'credentials missing'}`);
  console.log(`Reconcile: 0 open intents, ${loaded.length} of ${NAMES.length} credentials present. ${ok ? 'OK' : 'Refusing to start.'}`);
  db.close();
  process.exit(ok ? 0 : 1);
}

function signerStatus() {
  return new Promise((resolve) => {
    const sock = connect('/run/zeroed-signer/signer.sock');
    let buf = '';
    const done = (s) => {
      sock.destroy();
      resolve(s);
    };
    sock.setTimeout(2000, () => done('timeout'));
    sock.on('error', () => done('unreachable'));
    sock.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        try {
          done(JSON.parse(buf).status);
        } catch {
          done('bad reply');
        }
      }
    });
    sock.on('connect', () => sock.write('status\n'));
  });
}

let seq = 0;
let paused = false;
// The heartbeat key arrives with the watchdog (OPS-1b); until then no heartbeat is sent.
const key = credDir && existsSync(join(credDir, 'heartbeat_hmac_key')) ? readFileSync(join(credDir, 'heartbeat_hmac_key'), 'utf8') : '';

async function beat() {
  seq += 1;
  const signer = await signerStatus();
  event('heartbeat', `seq ${seq}, signer ${signer}`);
  if (!watchdog || !key) return;
  const body = JSON.stringify({
    seq,
    ts: Date.now(),
    boot: bootId,
    git_sha: gitSha,
    policy_version: 'stub',
    stub: true,
    last_processed_slot: null,
    feed_ages_ms: {},
    open_position: null,
    unresolved_intents: { count: 0, oldest_age_s: null },
    signer,
    lease_epoch: null,
    sol_reserve: null,
    paused,
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
  try {
    const res = await fetch(`${watchdog}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zeroed-signature': `t=${t},v1=${sig}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const reply = await res.json().catch(() => ({}));
    if (res.ok && reply.paused === true && !paused) {
      paused = true;
      event('pause', 'owner /pause via watchdog');
      console.log('Entries paused by the owner (watchdog). Exits keep running.');
    }
    if (!res.ok) console.log(`Heartbeat refused: HTTP ${res.status}`);
  } catch (e) {
    console.log(`Heartbeat failed: ${e.name}`);
  }
}

const bootId = `${Date.now().toString(36)}-${process.pid}`;
console.log(`Stub worker up: ${loaded.length} of ${NAMES.length} credentials, release ${gitSha.slice(0, 12)}, watchdog ${watchdog ? 'set' : 'not set'}.`);
event('start', gitSha);
await beat();
const timer = setInterval(() => void beat(), intervalMs);
const stop = () => {
  clearInterval(timer);
  event('stop');
  db.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
