// Stand-in for the worker until WORKER-1 lands. It exercises everything the host gives the real worker:
// encrypted credentials (it counts them, never prints them), the state directory with a SQLite ledger
// (so the hourly backup has real data), the signer socket, and the HMAC-signed heartbeat to the watchdog.
// `--reconcile` is the ExecStartPre step: the real worker settles open intents against the chain there.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
const ownerChat = loaded.includes('telegram_chat_id') ? readFileSync(join(credDir, 'telegram_chat_id'), 'utf8').trim() : null;
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
    owner_chat_id: ownerChat,
  });
  const t = Math.floor(Date.now() / 1000);
  // Signed text: timestamp, method, path, body (the watchdog refuses a signature on any other route).
  const sig = createHmac('sha256', key).update(`${t}\nPOST\n/heartbeat\n${body}`).digest('hex');
  try {
    const res = await fetch(`${watchdog}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zeroed-signature': `t=${t},v1=${sig}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let reply = {};
    try {
      reply = JSON.parse(text);
    } catch {}
    // The reply counts only when signed for this heartbeat: "t\nREPLY\n/heartbeat\n<our v1>\nbody" with the same key.
    const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(res.headers.get('x-zeroed-signature') ?? '');
    const want = m ? createHmac('sha256', key).update(`${m[1]}\nREPLY\n/heartbeat\n${sig}\n${text}`).digest('hex') : '';
    const signed = m !== null && timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(m[2], 'hex'));
    if (res.ok && !signed) console.log('Heartbeat reply not signed: an un-pause in it is ignored.');
    // Worker contract (ops/README.md): apply the watchdog's flag both ways, so the state and the message agree; an
    // unsigned reply may only start a pause (fail closed).
    if (res.ok && typeof reply.paused === 'boolean' && reply.paused !== paused && (signed || reply.paused)) {
      paused = reply.paused;
      event(paused ? 'pause' : 'resume', paused ? 'owner /pause via watchdog' : 'cleared from the host');
      console.log(paused ? 'Entries paused by the owner (watchdog). Exits keep running.' : 'Entries allowed again (pause cleared from the host).');
    }
    if (!res.ok) console.log(`Heartbeat refused: HTTP ${res.status}`);
  } catch (e) {
    console.log(`Heartbeat failed: ${e.name}`);
  }
}

const bootId = `${Date.now().toString(36)}-${process.pid}`;

// The worker API (ZEROED_API_ADDR), loopback only (ARCHITECTURE.md 12.4); `tailscale serve` publishes it to the
// owner's tailnet. Its /health lists the dry-run evidence kept on the host (`evidence`; zeroed-check writes the index).
const healthAddr = process.env.ZEROED_API_ADDR ?? '';
let server = null;
if (healthAddr) {
  const m = /^(127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(healthAddr);
  if (!m) {
    console.log('Refused: the worker API must bind loopback only.');
    process.exit(2);
  }
  const evidence = () => {
    try {
      const list = JSON.parse(readFileSync('/var/lib/zeroed-index/evidence.json', 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"not found"}');
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ stub: true, mode: 'paper', boot: bootId, seq, git_sha: gitSha, paused, signing_key: false, evidence: evidence() }));
  });
  server.listen(Number(m[2]), m[1].replace(/[[\]]/g, ''));
}
console.log(`Stub worker up: ${loaded.length} of ${NAMES.length} credentials, release ${gitSha.slice(0, 12)}, watchdog ${watchdog ? 'set' : 'not set'}.`);
event('start', gitSha);
await beat();
const timer = setInterval(() => void beat(), intervalMs);
const stop = () => {
  clearInterval(timer);
  server?.close();
  event('stop');
  db.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
