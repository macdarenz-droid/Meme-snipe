// RECORD-UPLOAD (owner, 2026-10-06: "Approve upload"; "Okay yes delete after upload"). Uploads the recorder's sealed files
// (public market data and the bot's own decisions; never keys, tokens, wallet or personal data) through the watchdog's
// signed POST /record to GitHub Release assets in the private data repository, one prerelease per UTC day (rec-YYYY-MM-DD,
// overflow rec-YYYY-MM-DD.N past 900 assets), and deletes a local frames or releases file only after its uploaded copy
// is read back with the same sha256 and size and the day's signed index lists it.
//   What goes: per boot, frames-NNN and releases-NNN (.jsonl.zst, listed with sha256 in the boot's manifest),
//   and once the boot has ended its manifest.json and its saved-state attachment; per ended UTC day, that day's
//   journal lines (journal-YYYY-MM-DD.jsonl.zst) and index-N.json. Never raw, delays or plain .jsonl files.
//   What is deleted (only with "record_upload_delete_local": true): frames and releases files of ended boots, each
//   checked again just before (see deleteFile). Never a manifest, a saved state, the journal, raw or delays files.
// Runs as the worker's user (zeroed-record-upload@.service: no capabilities, the recorder its only writable data path),
// one file at a time, oldest first, at 2 MB/s. Node built-ins only; curl sends the body with its headers on stdin.
//   node record-upload.mjs --scope all|YYYY-MM-DD
import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';

/** The worker's redaction patterns, kept identical to packages/worker/src/run/redact.ts (a test compares them). */
export const PATTERNS = [
  /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token)=)[^&\s"'\\]+/gi,
  /(\.alchemy\.com\/v2\/)[^\s"'\\/?#]+/gi,
  /(\/bot)\d+:[A-Za-z0-9_-]+/g,
];
const MARK = '[redacted]';
/** The credentials the worker holds, so the only ones its recordings could carry. */
export const CREDENTIALS = ['helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token', 'telegram_chat_id', 'heartbeat_hmac_key'];

export const DEFAULTS = {
  root: '/var/lib/zeroed/recorder',
  journal: '/var/lib/zeroed/journal.jsonl',
  stateDir: '/var/lib/zeroed-record-upload',
  hostConfig: '/opt/zeroed/current/ops/host-config.json',
};
/** A boot (or an open boot's file) unchanged this long counts as settled. */
export const QUIET_MS = 15 * 60_000;
/** The watchdog's body cap (the free plan allows 100 MB). */
export const MAX_BYTES = 95_000_000;
/** GitHub allows 1000 assets per release; past this many the day moves to its next overflow release. */
export const RELEASE_ASSETS = 900;
/** GitHub's secondary limit is 500 content writes an hour; a run stays well under it. */
export const MAX_UPLOADS_PER_RUN = 300;
/** A day's journal is uploaded once the day has ended and this much more has passed. */
const JOURNAL_GRACE_MS = 10 * 60_000;
const STOP_AFTER_FAILURES = 3;
const BOOT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATA_RE = /^days\/(\d{4}-\d{2}-\d{2})\/((?:frames|releases)-\d{3}\.jsonl\.zst)$/;
const ATTACHMENTS = new Set(['deployer-state.json', 'deployer-state.json.zst']);
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isBytes = (n) => Number.isSafeInteger(n) && n > 0;
/** True for "no such file": RECORD-BUDGET deletes recordings on its own schedule, so any file may vanish mid-run. */
const isGone = (e) => e?.code === 'ENOENT';
/** Recorder files (not the uploader's own journal and index copies): one that vanishes is reported once. */
const RECORDER_KINDS = new Set(['data', 'manifest', 'attachment']);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayEnd = (day) => Date.parse(`${day}T00:00:00Z`) + 86_400_000;

/** The boot's start time from its id (`<ms in base 36>-<pid>`), or null. */
export const bootTime = (boot) => {
  const m = /^([0-9a-z]{1,12})-\d{1,10}$/.exec(boot);
  const t = m ? parseInt(m[1], 36) : Number.NaN;
  return t > 1.5e12 && t < 4.1e12 ? t : null;
};

export const hashFile = async (path) => {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const c of createReadStream(path)) {
    h.update(c);
    bytes += c.length;
  }
  return { sha256: h.digest('hex'), bytes };
};

/** A reason (never the value) when the text holds a stored credential or a credential-shaped value not already redacted. */
export const hitIn = (text, values) => {
  for (const v of values) if (text.includes(v)) return 'a stored credential';
  for (const p of PATTERNS) for (const m of text.matchAll(p)) if (m[0].slice(m[1].length) !== MARK) return 'a credential-shaped value';
  return null;
};

const CARRY_MAX = 8 * 1024 * 1024;

/**
 * Streams the file (decompressed when .zst) through hitIn. Pieces end at a newline or a double quote, which no pattern
 * match and no credential value contains, so a split never hides one; memory stays flat. Null when clean.
 */
export const scanFile = async (path, values) => {
  const cuts = values.some((v) => v.includes('"')) ? ['\n'] : ['\n', '"'];
  const src = createReadStream(path);
  const dec = path.endsWith('.zst') ? createZstdDecompress() : null;
  // Not pipeline(): it may close the decompressor before its last output is read. A read error ends the loop below.
  if (dec) src.on('error', (e) => dec.destroy(e));
  const stream = dec ? src.pipe(dec) : src;
  const td = new TextDecoder('utf-8');
  let carry = '';
  let hit = null;
  try {
    for await (const chunk of stream) {
      const text = carry + td.decode(chunk, { stream: true });
      const cut = Math.max(...cuts.map((c) => text.lastIndexOf(c)));
      if (cut === -1) {
        carry = text;
        if (carry.length > CARRY_MAX) return 'a run of text too long to check';
        continue;
      }
      hit = hitIn(text.slice(0, cut + 1), values);
      if (hit) return hit;
      carry = text.slice(cut + 1);
    }
    return hitIn(carry + td.decode(), values);
  } finally {
    src.destroy();
    dec?.destroy();
  }
};

/** Written to a temporary file, flushed to disk, renamed over the old one, and the folder flushed too. */
export const writeAtomic = (path, text) => {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const d = openSync(dirname(path), 'r');
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
};

const freshState = () => ({ v: 1, files: {}, shared: {}, releases: {}, journal: { offset: 0, days: {}, pending: null }, index: {}, failed_runs: 0 });

/** The saved state; a missing or unreadable one starts fresh (GitHub is the record: names that exist are matched again). */
export const loadState = (dir) => {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    if (s && s.v === 1 && typeof s.files === 'object') return { ...freshState(), ...s, journal: { ...freshState().journal, ...s.journal } };
  } catch {}
  return freshState();
};

/** The boot of the journal's last start line, read back from the end in pieces (the journal is never read whole). */
export const lastStartBoot = (path) => {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    let pos = fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    while (pos > 0) {
      const n = Math.min(1 << 20, pos);
      pos -= n;
      const b = Buffer.alloc(n);
      readSync(fd, b, 0, n, pos);
      tail = Buffer.concat([b, tail]);
      const first = pos === 0 ? 0 : tail.indexOf(0x0a) + 1;
      if (first === 0 && pos > 0) continue;
      const lines = tail.subarray(first).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!/"kind"\s*:\s*"start"/.test(lines[i])) continue;
        try {
          const j = JSON.parse(lines[i]);
          if (j.kind === 'start' && typeof j.boot === 'string') return j.boot;
        } catch {}
      }
      tail = tail.subarray(0, first);
    }
    return null;
  } finally {
    closeSync(fd);
  }
};

/** True unless systemd says the worker is inactive or failed (no answer counts as running). */
export const systemWorkerActive = () =>
  new Promise((resolve) => {
    execFile('systemctl', ['is-active', 'zeroed-worker.service'], { timeout: 30_000 }, (_e, out) => {
      const s = String(out ?? '').trim();
      resolve(!(s === 'inactive' || s === 'failed'));
    });
  });

/** Walks a boot folder: settled when no plain .jsonl, no .tmp and no link is in it and nothing changed for QUIET_MS. */
export const settled = (dir, now) => {
  let newest = 0;
  const walk = (d) => {
    const st = lstatSync(d);
    newest = Math.max(newest, st.mtimeMs);
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = lstatSync(p);
      if (s.isSymbolicLink()) return 'a link';
      if (name.endsWith('.jsonl') || name.endsWith('.tmp')) return 'an open file';
      if (s.isDirectory()) {
        const w = walk(p);
        if (w) return w;
      } else {
        newest = Math.max(newest, s.mtimeMs);
      }
    }
    return null;
  };
  const why = walk(dir);
  if (why) return why;
  return now - newest < QUIET_MS ? 'changed in the last 15 minutes' : null;
};

/**
 * The recorder's boot folders, oldest first, each with its manifest and whether it is open: the running boot (the
 * journal's last start), the newest folder while the worker runs, and any folder not settled. An open boot's sealed
 * files are uploaded (they never change once sealed), but nothing in it is ever deleted.
 */
export const readBoots = async (cfg, now, workerActive) => {
  if (!existsSync(cfg.root)) return [];
  const boots = [];
  for (const name of readdirSync(cfg.root)) {
    if (!BOOT_RE.test(name) || name === 'saved-state') continue;
    const dir = join(cfg.root, name);
    let manifest = null;
    let mtime = 0;
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      const mp = join(dir, 'manifest.json');
      const st = lstatSync(mp);
      if (!st.isFile()) continue;
      mtime = st.mtimeMs;
      manifest = JSON.parse(readFileSync(mp, 'utf8'));
    } catch {
      continue;
    }
    if (manifest?.boot !== name || manifest.source !== 'live-recorder' || !Array.isArray(manifest.days)) continue;
    boots.push({ boot: name, dir, manifest, time: bootTime(name) ?? mtime });
  }
  boots.sort((a, b) => a.time - b.time || (a.boot < b.boot ? -1 : 1));
  const running = await runningBoots(cfg, boots, workerActive);
  for (const b of boots) {
    let why;
    try {
      why = running.has(b.boot) ? 'the running boot' : settled(b.dir, now);
    } catch (e) {
      if (!isGone(e)) throw e;
      // A file went while the folder was walked: open for this run (its sealed files still go up, nothing is deleted).
      why = 'a file went while it was listed';
    }
    b.open = why !== null;
    b.why = why;
  }
  return boots;
};

/** The boots that may still be written: the journal's last start, and the newest folder while the worker is up. */
const runningBoots = async (cfg, boots, workerActive) => {
  const out = new Set();
  const started = lastStartBoot(cfg.journal);
  if (started) out.add(started);
  if (boots.length > 0 && (await workerActive())) out.add(boots[boots.length - 1].boot);
  return out;
};

const firstDay = (b) => {
  const days = b.manifest.days.map((d) => d.day).filter((d) => typeof d === 'string' && DAY_RE.test(d)).sort();
  const t = bootTime(b.boot);
  return days[0] ?? (t === null ? null : dayOf(t));
};

/** What one boot contributes: its listed frames and releases files; once ended, its manifest and saved-state attachment. */
export const itemsOf = (b) => {
  const items = [];
  for (const d of b.manifest.days) {
    for (const f of Array.isArray(d?.files) ? d.files : []) {
      const m = DATA_RE.exec(f?.path ?? '');
      if (!m || m[1] !== d.day || !isSha(f.sha256) || !isBytes(f.bytes)) continue;
      items.push({ key: `${b.boot}/${f.path}`, kind: 'data', boot: b.boot, day: d.day, path: join(b.dir, f.path), rel: f.path, file: m[2], size: f.bytes, sha256: f.sha256, open: b.open });
    }
  }
  const day = firstDay(b);
  if (!b.open && day !== null) {
    items.push({ key: `${b.boot}/manifest.json`, kind: 'manifest', boot: b.boot, day, path: join(b.dir, 'manifest.json'), rel: 'manifest.json', file: 'manifest.json', size: null, sha256: null, open: false });
    for (const a of Array.isArray(b.manifest.attachments) ? b.manifest.attachments : []) {
      if (!ATTACHMENTS.has(a?.file) || !isSha(a.sha256) || !isBytes(a.bytes)) continue;
      items.push({ key: `${b.boot}/${a.file}`, kind: 'attachment', boot: b.boot, day, path: join(b.dir, a.file), rel: a.file, file: a.file, size: a.bytes, sha256: a.sha256, open: false });
    }
  }
  return items;
};

/** The signed header for one request: the watchdog checks "t\nRECORD\n/record\n<header>" with the heartbeat key. */
export const signHeader = (key, fields, nowS) => {
  const text = JSON.stringify({ v: 1, op: fields.op, t: nowS, nonce: randomBytes(16).toString('hex'), day: fields.day, release: fields.release, boot: fields.boot, file: fields.file, size: fields.size, sha256: fields.sha256, ...(fields.op === 'check' ? { asset_id: fields.asset_id } : {}) });
  const sig = createHmac('sha256', key).update(`${nowS}\nRECORD\n/record\n${text}`).digest('hex');
  return { text, signature: `t=${nowS},v1=${sig}` };
};

/** The index's last line: an HMAC with the heartbeat key over "RECORD-INDEX\n<body>". */
export const signIndex = (key, body) => `${body}\nhmac-sha256=${createHmac('sha256', key).update(`RECORD-INDEX\n${body}`).digest('hex')}\n`;

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The real transport: curl for an upload (config and headers on stdin, never in argv), fetch for a read-back. */
export const watchdogTransport = (url, curl = 'curl') => ({
  put: (h, path, size) =>
    new Promise((resolve) => {
      const conf = [
        `url = ${quote(`${url}/record`)}`, 'request = "POST"', `upload-file = ${quote(path)}`,
        `header = ${quote(`x-zeroed-record: ${h.text}`)}`, `header = ${quote(`x-zeroed-signature: ${h.signature}`)}`,
        'header = "content-type: application/octet-stream"', 'header = "expect:"', 'limit-rate = 2M', 'connect-timeout = 30',
        `max-time = ${Math.ceil(size / 2_000_000) + 300}`, 'silent', 'show-error', 'write-out = "\\n%{http_code}"',
      ].join('\n');
      const c = spawn(curl, ['-K', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (err += d));
      c.on('error', () => resolve({ status: 0, json: null, error: 'curl did not start' }));
      c.on('close', (code) => {
        const nl = out.lastIndexOf('\n');
        const status = Number(out.slice(nl + 1));
        let json = null;
        try {
          json = JSON.parse(out.slice(0, nl));
        } catch {}
        resolve({ status: Number.isInteger(status) ? status : 0, json, ...(code === 0 ? {} : { error: `curl exit ${code}: ${err.trim().slice(0, 200)}` }) });
      });
      c.stdin.end(`${conf}\n`);
    }),
  check: async (h) => {
    try {
      const res = await fetch(`${url}/record`, { method: 'POST', headers: { 'x-zeroed-record': h.text, 'x-zeroed-signature': h.signature }, signal: AbortSignal.timeout(60_000) });
      return { status: res.status, json: await res.json().catch(() => null) };
    } catch {
      return { status: 0, json: null, error: 'the watchdog did not answer' };
    }
  },
});

export class Uploader {
  /**
   * cfg: { root, journal, stateDir, key, values, deleteLocal, scope ('all' | day) }.
   * deps: { transport: { put, check }, workerActive: () => Promise<boolean>, now: () => ms, log }.
   */
  constructor(cfg, deps) {
    this.cfg = cfg;
    this.d = deps;
    this.state = loadState(cfg.stateDir);
    this.kept = [];
    this.failures = 0;
    this.inARow = 0;
    this.uploads = 0;
    this.counts = { uploaded: 0, verified: 0, deleted: 0, freed_bytes: 0, vanished: 0 };
    this.vanishedFiles = [];
    this.lastError = null;
    this.stopped = false;
    this.lastStatus = 0;
    mkdirSync(join(cfg.stateDir, 'tmp'), { recursive: true });
  }

  save() {
    writeAtomic(join(this.cfg.stateDir, 'state.json'), `${JSON.stringify(this.state)}\n`);
  }

  status(extra) {
    writeAtomic(join(this.cfg.stateDir, 'status.json'), `${JSON.stringify({ v: 1, at: this.d.now(), scope: this.cfg.scope, delete_local: this.cfg.deleteLocal, failed_runs: this.state.failed_runs, ...this.counts, vanished_files: this.vanishedFiles, kept: this.kept, last_error: this.lastError, ...extra })}\n`);
  }

  /** The status file, at most once a minute during a run, so a long first run never looks stalled. */
  tick() {
    if (this.d.now() - this.lastStatus < 60_000) return;
    this.lastStatus = this.d.now();
    this.status({ running: true });
  }

  fail(what) {
    this.failures++;
    this.inARow++;
    this.lastError = what;
    this.d.log(`Not uploaded: ${what}.`);
    if (this.inARow >= STOP_AFTER_FAILURES) this.stopped = true;
  }

  keep(key, why) {
    this.kept.push({ key, why });
    this.d.log(`Kept on the server, not uploaded: ${key} (${why}).`);
  }

  /**
   * A listed file that is no longer on the server (deleted before it was sent): skipped, counted and reported, never a
   * failure, and the run goes on. A recorder file is marked in the state so it is reported once and not tried again; an
   * asset sent earlier but not yet confirmed is still read back on later runs.
   */
  vanish(it) {
    const files = this.state.files;
    if (files[it.key]?.vanished_at) return;
    if (RECORDER_KINDS.has(it.kind)) {
      files[it.key] = { ...(files[it.key] ?? { day: it.day, boot: it.boot, path: it.rel }), vanished_at: this.d.now() };
      this.save();
    }
    this.counts.vanished++;
    this.vanishedFiles.push(it.key);
    this.d.log(`Vanished before upload: ${it.key}.`);
  }

  release(day) {
    const r = (this.state.releases[day] ??= { n: 0, count: 0 });
    if (r.count >= RELEASE_ASSETS && r.n < 99) {
      r.n++;
      r.count = 0;
    }
    return r.n === 0 ? `rec-${day}` : `rec-${day}.${r.n}`;
  }

  /** Reads an asset back by id through the watchdog; true only for exactly these bytes, finished, under this name. */
  async verify(rec, it) {
    const h = signHeader(this.cfg.key, { op: 'check', day: it.day, release: rec.release, boot: it.boot, file: it.file, size: rec.size, sha256: rec.sha256, asset_id: rec.asset_id }, Math.floor(this.d.now() / 1000));
    const r = await this.d.transport.check(h);
    const j = r.json ?? {};
    return r.status === 200 && j.ok === true && j.match === true && j.asset_id === rec.asset_id && j.size === rec.size && j.digest === `sha256:${rec.sha256}` && j.state === 'uploaded';
  }

  /** One file: checked, scanned, hashed again, sent, read back. The state is saved after every step that changes it. */
  async upload(it) {
    const files = this.state.files;
    const rec = files[it.key];
    if (rec?.verified || rec?.deleted_at) return;
    if (rec?.asset_id) {
      // Sent before but not confirmed (no digest yet, or the read-back did not answer): read it back again.
      if (await this.verify(rec, it)) {
        rec.verified = true;
        this.counts.verified++;
        this.inARow = 0;
        this.save();
        return;
      }
    }
    if (rec?.vanished_at || this.uploads >= MAX_UPLOADS_PER_RUN) return;
    try {
      await this.send(it);
    } catch (e) {
      if (!isGone(e)) throw e;
      this.vanish(it);
    }
  }

  /** upload()'s checks and sends; a file that vanishes at any step throws ENOENT, which upload() reports. */
  async send(it) {
    const files = this.state.files;
    const rec = files[it.key];
    const st = lstatSync(it.path);
    if (!st.isFile()) return this.keep(it.key, 'not a plain file');
    if (it.open && this.d.now() - st.mtimeMs < QUIET_MS) return;
    if (st.size > MAX_BYTES) return this.keep(it.key, 'over 95 MB');
    if (it.sha256 !== null && st.size !== it.size) return this.keep(it.key, 'size differs from its manifest');
    const before = await hashFile(it.path);
    if (it.sha256 !== null && (before.sha256 !== it.sha256 || before.bytes !== it.size)) return this.keep(it.key, 'bytes differ from its manifest');
    let hit;
    try {
      hit = await scanFile(it.path, this.cfg.values);
    } catch (e) {
      if (isGone(e)) throw e;
      hit = 'unreadable text';
    }
    if (hit) return this.keep(it.key, `holds ${hit}`);
    // Hashed again just before sending: the watchdog keeps the asset only if GitHub's digest equals this.
    const h0 = await hashFile(it.path);
    if (h0.sha256 !== before.sha256 || h0.bytes !== before.bytes) return this.fail(`${it.key}: changed while it was checked`);
    const shared = it.kind === 'attachment' ? files[this.state.shared[h0.sha256]] : undefined;
    if (shared?.verified) {
      // The same saved state is already up (an earlier boot restored the same bytes): listed, never sent twice.
      files[it.key] = { day: it.day, boot: it.boot, path: it.rel, release: shared.release, asset: shared.asset, asset_id: shared.asset_id, size: shared.size, sha256: shared.sha256, verified: true, ref: this.state.shared[h0.sha256] };
      this.save();
      return;
    }
    const release = rec?.release ?? this.release(it.day);
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = signHeader(this.cfg.key, { op: 'put', day: it.day, release, boot: it.boot, file: it.file, size: h0.bytes, sha256: h0.sha256 }, Math.floor(this.d.now() / 1000));
      this.uploads++;
      const r = await this.d.transport.put(h, it.path, h0.bytes);
      const j = r.json ?? {};
      if (r.status === 200 && j.ok === true && Number.isSafeInteger(j.asset_id)) {
        const next = { day: it.day, boot: it.boot, path: it.rel, release, asset: j.name, asset_id: j.asset_id, size: h0.bytes, sha256: h0.sha256, verified: false };
        files[it.key] = next;
        const r0 = (this.state.releases[it.day] ??= { n: 0, count: 0 });
        if (!j.existed && release === (r0.n === 0 ? `rec-${it.day}` : `rec-${it.day}.${r0.n}`)) r0.count++;
        this.counts.uploaded++;
        this.save();
        // Never the upload's reply: a fresh read-back by id decides.
        if (await this.verify(next, it)) {
          next.verified = true;
          this.counts.verified++;
          if (it.kind === 'attachment') this.state.shared[h0.sha256] ??= it.key;
          this.inARow = 0;
          this.save();
        } else {
          this.fail(`${it.key}: uploaded, but the read-back did not confirm it`);
        }
        return;
      }
      if (r.status === 503 && j.retry === true) continue;
      if (r.status === 409 && j.error === 'replayed request') continue;
      if (r.status === 409) return this.keep(it.key, 'a different file has this name in the data repository');
      if (Number.isSafeInteger(j.asset_id)) {
        files[it.key] = { day: it.day, boot: it.boot, path: it.rel, release, asset: j.name ?? null, asset_id: j.asset_id, size: h0.bytes, sha256: h0.sha256, verified: false };
        this.save();
      }
      // curl could not read a file deleted while it was sent: that is a vanish, not a failure.
      if (!existsSync(it.path)) return this.vanish(it);
      return this.fail(`${it.key}: HTTP ${r.status}${typeof j.error === 'string' ? ` (${j.error})` : ''}${r.error ? ` (${r.error})` : ''}`);
    }
    this.fail(`${it.key}: the watchdog asked to send again three times`);
  }

  /**
   * Each ended UTC day's journal lines as journal-YYYY-MM-DD.jsonl.zst, read forward from the saved offset. A line goes
   * to the later of its own day and the day being collected, so every line is sent exactly once, in order.
   */
  async journalDays() {
    const j = this.state.journal;
    const path = this.cfg.journal;
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < j.offset) {
      this.d.log('The journal is shorter than the saved offset; reading it again from the start (days already up are skipped).');
      j.offset = 0;
      j.pending = null;
    }
    while (!this.stopped && this.uploads < MAX_UPLOADS_PER_RUN) {
      const group = j.pending && existsSync(this.journalTmp(j.pending.day)) ? j.pending : await this.collectDay(j.offset);
      if (group === null) return;
      if (!j.days[group.day]) {
        j.pending = group;
        this.save();
        const it = { key: `journal/${group.day}`, kind: 'journal', boot: null, day: group.day, path: this.journalTmp(group.day), rel: `journal-${group.day}.jsonl.zst`, file: `journal-${group.day}.jsonl.zst`, size: group.size, sha256: group.sha256, open: false };
        await this.upload(it);
        if (!this.state.files[it.key]?.verified) return;
        j.days[group.day] = true;
      }
      j.offset = group.end;
      j.pending = null;
      rmSync(this.journalTmp(group.day), { force: true });
      this.save();
    }
  }

  journalTmp(day) {
    return join(this.cfg.stateDir, 'tmp', `journal-${day}.jsonl.zst`);
  }

  /** The first ended day from offset on, compressed to the temporary folder; null when the day there has not ended. */
  async collectDay(offset) {
    const now = this.d.now();
    const lines = createReadStream(this.cfg.journal, { start: offset });
    let pos = offset;
    let rest = Buffer.alloc(0);
    let day = null;
    let end = null;
    const self = this;
    const isDone = (d) => d !== null && now >= dayEnd(d) + JOURNAL_GRACE_MS;
    async function* group() {
      for await (const chunk of lines) {
        let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        let i;
        while ((i = buf.indexOf(0x0a)) !== -1) {
          const line = buf.subarray(0, i + 1);
          const m = /"ts":"(\d{4}-\d{2}-\d{2})T/.exec(line.subarray(0, 200).toString('latin1'));
          const lineDay = m ? m[1] : day;
          const d = day === null ? lineDay : lineDay !== null && lineDay > day ? lineDay : day;
          if (day !== null && d !== day) {
            end = pos;
            return;
          }
          if (day === null && d !== null) {
            day = d;
            if (!isDone(day)) return;
          }
          yield line;
          pos += line.length;
          buf = buf.subarray(i + 1);
        }
        rest = Buffer.from(buf);
      }
      // End of the file: the day is complete only once it has ended (a torn last line is never sent).
      if (day !== null && isDone(day)) end = pos;
    }
    const tmp = join(self.cfg.stateDir, 'tmp', 'journal.part');
    await pipeline(group, createZstdCompress(), createWriteStream(tmp, { mode: 0o600 }));
    lines.destroy();
    if (day === null || end === null || !isDone(day) || end === offset) {
      rmSync(tmp, { force: true });
      return null;
    }
    renameSync(tmp, this.journalTmp(day));
    const h = await hashFile(this.journalTmp(day));
    return { day, end, sha256: h.sha256, size: h.bytes };
  }

  /** index-N.json for a day once its uploaded set changed: every confirmed file with its asset and sha256, and the boots' manifests. */
  async index(day) {
    const st = (this.state.index[day] ??= { n: 0, hash: null, verified: false, keys: [], pending: null });
    const entries = Object.entries(this.state.files)
      .filter(([key, r]) => r.day === day && r.verified && !key.startsWith('index/'))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, r]) => ({ key, boot: r.boot, path: r.path, release: r.release, asset: r.asset, asset_id: r.asset_id, size: r.size, sha256: r.sha256 }));
    if (entries.length === 0) return;
    const hash = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    if (st.pending === null && st.verified && st.hash === hash) return;
    if (st.pending === null || !existsSync(this.indexTmp(day, st.pending.n))) {
      const n = st.n + 1;
      const boots = {};
      for (const e of entries) {
        if (e.boot === null || boots[e.boot]) continue;
        try {
          boots[e.boot] = JSON.parse(readFileSync(join(this.cfg.root, e.boot, 'manifest.json'), 'utf8'));
        } catch {
          boots[e.boot] = null;
        }
      }
      const body = JSON.stringify({ v: 1, kind: 'zeroed-record-index', day, n, created: new Date(this.d.now()).toISOString(), files: entries, boots });
      writeAtomic(this.indexTmp(day, n), signIndex(this.cfg.key, body));
      const h = await hashFile(this.indexTmp(day, n));
      st.pending = { n, hash, keys: entries.map((e) => e.key), sha256: h.sha256, size: h.bytes };
      this.save();
    }
    const p = st.pending;
    const key = `index/${day}/${p.n}`;
    await this.upload({ key, kind: 'index', boot: null, day, path: this.indexTmp(day, p.n), rel: `index-${p.n}.json`, file: `index-${p.n}.json`, size: p.size, sha256: p.sha256, open: false });
    const rec = this.state.files[key];
    if (!rec?.verified) return;
    // The index is a file of its own, never an entry of another index.
    delete this.state.files[key];
    this.state.index[day] = { n: p.n, hash: p.hash, verified: true, keys: p.keys, pending: null, release: rec.release, asset: rec.asset, asset_id: rec.asset_id, size: rec.size, sha256: rec.sha256 };
    rmSync(this.indexTmp(day, p.n), { force: true });
    this.save();
  }

  indexTmp(day, n) {
    return join(this.cfg.stateDir, 'tmp', `index-${day}-${n}.json`);
  }

  /** The day's newest index, read back now: it must still be there before anything it lists is deleted. */
  async indexStands(day) {
    const s = this.state.index[day];
    if (!s?.verified) return false;
    return this.verify(s, { day, boot: null, file: `index-${s.n}.json` });
  }

  /**
   * Deletes one frames or releases file of an ended boot, only when all hold: (1) listed with this sha256 and size in its
   * boot's manifest, read again now, and the file hashes to it now; (2) its boot is not running, checked again now; (3) a
   * plain file whose real path is inside the recorder folder; (4) GitHub's asset, read back now, has digest
   * sha256:<local>, the same size and state "uploaded"; (5) the day's signed index lists it and still stands; (6) the
   * delete is in the state file before the file goes. Anything else keeps the file.
   */
  async deleteFile(it, running) {
    const rec = this.state.files[it.key];
    if (!rec?.verified || rec.deleted_at || it.kind !== 'data') return;
    const m = DATA_RE.exec(it.rel);
    if (!m || running.has(it.boot)) return;
    if (!this.state.index[it.day]?.keys.includes(it.key)) return;
    try {
      // The recorder folder itself must be a real folder at its own path: nothing outside it is ever deleted.
      if (lstatSync(this.cfg.root).isSymbolicLink()) return;
      const root = realpathSync(this.cfg.root);
      const path = join(root, it.boot, it.rel);
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || realpathSync(path) !== path || !path.startsWith(`${root}/`)) return;
      const man = JSON.parse(readFileSync(join(root, it.boot, 'manifest.json'), 'utf8'));
      const listed = (man.days ?? []).find((d) => d?.day === m[1])?.files?.find((f) => f?.path === it.rel);
      if (!listed || listed.sha256 !== rec.sha256 || listed.bytes !== rec.size || rec.sha256 !== it.sha256) return;
      const h = await hashFile(path);
      if (h.sha256 !== rec.sha256 || h.bytes !== rec.size) return;
      if (!(await this.verify(rec, it))) return;
      rec.deleting = this.d.now();
      this.save();
      unlinkSync(path);
      rec.deleted_at = this.d.now();
      delete rec.deleting;
      this.counts.deleted++;
      this.counts.freed_bytes += h.bytes;
      this.save();
    } catch (e) {
      this.d.log(`Kept ${it.key}: ${e instanceof Error ? e.code ?? 'error' : 'error'} while checking it.`);
    }
  }

  async run() {
    const now = this.d.now();
    this.state.failed_runs++;
    this.save();
    this.status({ running: true });
    try {
      const boots = await readBoots(this.cfg, now, this.d.workerActive);
      const items = boots.flatMap(itemsOf);
      const days = [...new Set(items.map((i) => i.day))].sort().filter((d) => this.cfg.scope === 'all' || d === this.cfg.scope);
      for (const day of days) {
        if (this.stopped) break;
        for (const it of items.filter((i) => i.day === day)) {
          if (this.stopped) break;
          await this.upload(it);
          this.tick();
        }
      }
      if (!this.stopped) await this.journalDays();
      const touched = [...new Set(Object.values(this.state.files).map((r) => r.day))].sort().filter((d) => this.cfg.scope === 'all' || d === this.cfg.scope);
      for (const day of touched) if (!this.stopped) await this.index(day);
      if (this.cfg.deleteLocal && !this.stopped) {
        // The running set is read again now, not taken from the start of the run.
        const fresh = await readBoots(this.cfg, this.d.now(), this.d.workerActive);
        const running = new Set(fresh.filter((b) => b.open).map((b) => b.boot));
        for (const day of days) {
          const mine = items.filter((i) => i.day === day && i.kind === 'data' && this.state.files[i.key]?.verified && !this.state.files[i.key]?.deleted_at);
          if (mine.length === 0 || !(await this.indexStands(day))) continue;
          for (const it of mine) await this.deleteFile(it, running);
        }
      }
      // Each waiting file's age, read once; one deleted meanwhile is left out.
      const pending = items
        .filter((i) => !this.state.files[i.key]?.verified && !this.state.files[i.key]?.deleted_at && !this.state.files[i.key]?.vanished_at && !this.kept.some((k) => k.key === i.key) && existsSync(i.path))
        .map((i) => {
          try {
            return statSync(i.path).mtimeMs;
          } catch (e) {
            if (isGone(e)) return null;
            throw e;
          }
        })
        .filter((t) => t !== null);
      const oldest = pending.reduce((m, t) => Math.min(m, t), this.journalBacklogFrom());
      if (this.failures === 0) this.state.failed_runs = 0;
      this.save();
      this.status({ running: false, ok: this.failures === 0, pending: pending.length, backlog_age_s: Number.isFinite(oldest) ? Math.max(0, Math.round((this.d.now() - oldest) / 1000)) : 0 });
      this.d.log(`Recording upload: ${this.counts.uploaded} sent, ${this.counts.verified} confirmed, ${this.counts.deleted} deleted (${this.counts.freed_bytes} bytes), ${this.counts.vanished} vanished before upload, ${pending.length} waiting, ${this.kept.length} kept, ${this.failures} failed.`);
      return this.failures === 0 ? 0 : 1;
    } catch (e) {
      this.lastError = e instanceof Error ? `${e.name}: ${e.code ?? e.message.slice(0, 120)}` : 'error';
      this.status({ running: false, ok: false });
      this.d.log(`Recording upload stopped: ${this.lastError}.`);
      return 1;
    }
  }

  /** When the oldest ended day still waiting in the journal ended (Infinity when none waits). */
  journalBacklogFrom() {
    const j = this.state.journal;
    if (!existsSync(this.cfg.journal) || statSync(this.cfg.journal).size <= j.offset) return Number.POSITIVE_INFINITY;
    const first = j.pending?.day ?? null;
    if (first !== null) return dayEnd(first);
    try {
      const b = Buffer.alloc(200);
      const fd = openSync(this.cfg.journal, 'r');
      try {
        readSync(fd, b, 0, 200, j.offset);
      } finally {
        closeSync(fd);
      }
      const m = /"ts":"(\d{4}-\d{2}-\d{2})T/.exec(b.toString('latin1'));
      return m && this.d.now() >= dayEnd(m[1]) ? dayEnd(m[1]) : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
}

/** Credentials from systemd's credentials folder (trimmed as the worker reads them); values under 8 characters are not scanned for, as the worker does not redact them. */
export const readCredentials = (dir) => {
  const read = (n) => {
    try {
      const v = readFileSync(join(dir, n), 'utf8').trim();
      return v === '' ? null : v;
    } catch {
      return null;
    }
  };
  const key = dir ? read('heartbeat_hmac_key') : null;
  const values = dir ? CREDENTIALS.map(read).filter((v) => v !== null && v.length >= 8) : [];
  return { key, values: [...new Set(values)].sort((a, b) => b.length - a.length) };
};

const main = async () => {
  const i = process.argv.indexOf('--scope');
  const scope = i === -1 ? 'all' : process.argv[i + 1];
  if (scope !== 'all' && !(DAY_RE.test(scope ?? '') && dayOf(Date.parse(`${scope}T00:00:00Z`)) === scope)) {
    console.log('Usage: record-upload.mjs --scope all|YYYY-MM-DD');
    return 2;
  }
  const cfg = { ...DEFAULTS, scope };
  let hc = {};
  try {
    hc = JSON.parse(readFileSync(cfg.hostConfig, 'utf8'));
  } catch {}
  if (hc.record_upload !== true) {
    console.log('Recording upload is off (ops/host-config.json "record_upload").');
    // The unit's state folder (systemd makes it); never created here.
    if (existsSync(cfg.stateDir)) writeAtomic(join(cfg.stateDir, 'status.json'), `${JSON.stringify({ v: 1, at: Date.now(), enabled: false })}\n`);
    return 0;
  }
  const { key, values } = readCredentials(process.env.CREDENTIALS_DIRECTORY);
  const url = process.env.WATCHDOG_URL ?? '';
  const up = new Uploader(
    { ...cfg, key: key ?? '', values, deleteLocal: hc.record_upload_delete_local === true },
    { transport: watchdogTransport(url.replace(/\/+$/, '')), workerActive: systemWorkerActive, now: Date.now, log: (s) => console.log(s) },
  );
  if (!key || !/^https?:\/\/[^\s"]+$/.test(url)) {
    up.state.failed_runs++;
    up.save();
    up.lastError = !key ? 'no heartbeat key' : 'no watchdog address';
    up.status({ running: false, ok: false });
    console.log(`Recording upload cannot run: ${up.lastError}.`);
    return 1;
  }
  return up.run();
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.log(`Recording upload failed: ${e instanceof Error ? e.name : 'error'}.`);
      process.exit(1);
    },
  );
}
