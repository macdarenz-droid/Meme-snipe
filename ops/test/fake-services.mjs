// Local stand-in for github.com (release downloads, dumb-HTTP git), api.github.com (release metadata, and the private data
// repository e2e-owner/zeroed-data with uploads.github.com for RECORD-UPLOAD) and
// api.telegram.org (getUpdates, sendMessage, sendDocument, setWebhook, deleteWebhook, getWebhookInfo), for ops/test/e2e.sh. State lives in files under STATE so the
// gh and wrangler stubs can share it. Never logs a request URL (a bot token would be in it): the token is
// only compared with the token Telegram knows and the result recorded as true or false.
//   STATE=dir GIT_ROOT=dir PORT=8787 node fake-services.mjs
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';

const STATE = process.env.STATE;
const GIT_ROOT = process.env.GIT_ROOT;
// The bot token Telegram knows: $STATE/telegram-token (the test rotates it), read on every request.
const token = () => readFileSync(join(STATE, 'telegram-token'), 'utf8');
const rel = (tag) => join(STATE, 'releases', tag);
// The bot's webhook as Telegram holds it: $STATE/webhook.json ({} when none). The test may overwrite it.
const webhook = () => {
  try {
    return JSON.parse(readFileSync(join(STATE, 'webhook.json'), 'utf8'));
  } catch {
    return {};
  }
};

// RECORD-UPLOAD: the private data repository as GitHub answers it: the repository (private), contents, releases by tag
// and created, asset uploads (a Content-Length is required, as GitHub refuses chunked bodies; each upload is logged with
// whether it had one), assets by id (digest "sha256:<hex>") and their deletion, and a release's asset list.
const DATA = 'e2e-owner/zeroed-data';
const dataDir = () => join(STATE, 'data-repo');
const dataState = () => {
  try {
    return JSON.parse(readFileSync(join(dataDir(), 'state.json'), 'utf8'));
  } catch {
    return { next: 1, releases: {}, assets: {}, contents: {} };
  }
};
const saveData = (d) => {
  mkdirSync(join(dataDir(), 'assets'), { recursive: true });
  writeFileSync(join(dataDir(), 'state.json'), JSON.stringify(d));
};
const assetView = (a) => ({ id: a.id, name: a.name, size: a.size, state: 'uploaded', digest: `sha256:${a.sha256}`, browser_download_url: `https://github.com/${DATA}/releases/download/${a.tag}/${a.name}` });
const dataRepo = (req, url, rest, bytes, send) => {
  const d = dataState();
  let m;
  if (rest === '' && req.method === 'GET') return send(200, JSON.stringify({ full_name: DATA, private: true }));
  if ((m = /^\/contents\/(.+)$/.exec(rest))) {
    if (req.method === 'GET') return d.contents[m[1]] ? send(200, JSON.stringify({ sha: d.contents[m[1]] })) : send(404, '{"message":"Not Found"}');
    d.contents[m[1]] = createHash('sha1').update(bytes).digest('hex');
    saveData(d);
    return send(201, '{}');
  }
  if ((m = /^\/releases\/tags\/([^/]+)$/.exec(rest)) && req.method === 'GET') {
    const r = d.releases[m[1]];
    if (!r) return send(404, '{"message":"Not Found"}');
    return send(200, JSON.stringify({ id: r.id, tag_name: m[1], assets: Object.values(d.assets).filter((a) => a.tag === m[1]).map(assetView) }));
  }
  if (rest === '/releases' && req.method === 'POST') {
    const b = JSON.parse(bytes.toString('utf8'));
    if (d.releases[b.tag_name]) return send(422, '{"message":"Validation Failed","errors":[{"code":"already_exists"}]}');
    d.releases[b.tag_name] = { id: d.next++, body: b };
    saveData(d);
    appendFileSync(join(dataDir(), 'calls.jsonl'), JSON.stringify({ call: 'create-release', ...b }) + '\n');
    return send(201, JSON.stringify({ id: d.releases[b.tag_name].id, tag_name: b.tag_name }));
  }
  if ((m = /^\/releases\/(\d+)\/assets$/.exec(rest))) {
    const tag = Object.keys(d.releases).find((t) => d.releases[t].id === Number(m[1]));
    if (!tag) return send(404, '{"message":"Not Found"}');
    if (req.method === 'GET') return send(200, JSON.stringify(Object.values(d.assets).filter((a) => a.tag === tag).map(assetView)));
    const name = url.searchParams.get('name') ?? '';
    const length = req.headers['content-length'];
    const chunked = /chunked/i.test(req.headers['transfer-encoding'] ?? '');
    appendFileSync(join(dataDir(), 'calls.jsonl'), JSON.stringify({ call: 'upload', tag, name, length: length ?? null, chunked, bytes: bytes.length }) + '\n');
    if (length === undefined || chunked || Number(length) !== bytes.length) return send(400, '{"message":"Content-Length required"}');
    if (Object.values(d.assets).some((a) => a.tag === tag && a.name === name)) return send(422, '{"message":"Validation Failed","errors":[{"code":"already_exists","field":"name"}]}');
    const a = { id: d.next++, tag, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    d.assets[a.id] = a;
    saveData(d);
    writeFileSync(join(dataDir(), 'assets', String(a.id)), bytes);
    return send(201, JSON.stringify(assetView(a)));
  }
  if ((m = /^\/releases\/assets\/(\d+)$/.exec(rest))) {
    const a = d.assets[m[1]];
    if (!a) return send(404, '{"message":"Not Found"}');
    if (req.method === 'DELETE') {
      delete d.assets[m[1]];
      saveData(d);
      rmSync(join(dataDir(), 'assets', m[1]), { force: true });
      appendFileSync(join(dataDir(), 'calls.jsonl'), JSON.stringify({ call: 'delete', name: a.name }) + '\n');
      return send(204, '');
    }
    return send(200, JSON.stringify(assetView(a)));
  }
  return send(404, '{"message":"Not Found"}');
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('latin1');
  const send = (code, data, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(data);
  };

  let m;
  if ((m = /^\/repos\/e2e-owner\/zeroed-data(\/.*)?$/.exec(p))) return dataRepo(req, url, m[1] ?? '', Buffer.from(body, 'latin1'), send);
  if ((m = /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/bundle\.age$/.exec(p))) {
    const dir = rel(m[1]);
    if (!existsSync(join(dir, 'bundle.age'))) return send(404, 'Not Found', 'text/plain');
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    meta.download_count += 1;
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    return send(200, readFileSync(join(dir, 'bundle.age')), 'application/octet-stream');
  }
  if ((m = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/([^/]+)$/.exec(p))) {
    const dir = rel(m[1]);
    if (!existsSync(join(dir, 'meta.json'))) return send(404, '{"message":"Not Found"}');
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    return send(200, JSON.stringify({ tag_name: m[1], author: { login: meta.author }, assets: [{ name: 'bundle.age', download_count: meta.download_count }] }));
  }
  if ((m = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/check-runs$/.exec(p))) {
    // $STATE/checks/<sha> holds e2e's "success", "failure" or "pending" (check passes); no file means no check runs.
    const f = join(STATE, 'checks', m[1]);
    if (!existsSync(f)) return send(200, JSON.stringify({ total_count: 0, check_runs: [] }));
    const c = readFileSync(f, 'utf8').trim();
    const run = c === 'pending' ? { status: 'in_progress', conclusion: null } : { status: 'completed', conclusion: c };
    // A running Deploy job (zeroed-deploy) is always listed: the server must leave it out.
    // Every run is GitHub Actions' (the server counts no other app's).
    const app = { slug: 'github-actions' };
    return send(200, JSON.stringify({ total_count: 3, check_runs: [{ name: 'check', status: 'completed', conclusion: 'success', app }, { name: 'e2e', ...run, app }, { name: 'zeroed-deploy', status: 'in_progress', conclusion: null, app }] }));
  }
  if ((m = /^\/bot([^/]+)\/getUpdates$/.exec(p))) {
    // Messages the test "sends to the bot": one JSON object per line in $STATE/updates.jsonl.
    if (m[1] !== token()) return send(401, '{"ok":false}');
    // Like Telegram: no getUpdates while a webhook is set.
    if (webhook().url) return send(409, '{"ok":false,"error_code":409,"description":"Conflict: can\'t use getUpdates method while webhook is active"}');
    const offset = Number(new URLSearchParams(body).get('offset') ?? 0);
    const file = join(STATE, 'updates.jsonl');
    const all = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    appendFileSync(join(STATE, 'telegram.jsonl'), JSON.stringify({ method: 'getUpdates', token_ok: true, chat_id: '', text: '' }) + '\n');
    return send(200, JSON.stringify({ ok: true, result: all.filter((u) => u.update_id >= offset) }));
  }
  if ((m = /^\/client\/v4\/accounts\/([^/]+)\/workers\/subdomain$/.exec(p))) {
    // Cloudflare: the account starts without a workers.dev subdomain; PUT registers one.
    const auth_ok = req.headers['authorization'] === `Bearer ${readFileSync(join(STATE, 'cf-token'), 'utf8')}`;
    appendFileSync(join(STATE, 'cloudflare.jsonl'), JSON.stringify({ method: req.method, auth_ok, body }) + '\n');
    if (!auth_ok) return send(403, JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
    const f = join(STATE, 'cf-subdomain');
    if (req.method === 'PUT') {
      writeFileSync(f, JSON.parse(body).subdomain);
      return send(200, JSON.stringify({ success: true, result: { subdomain: JSON.parse(body).subdomain } }));
    }
    if (!existsSync(f)) return send(404, JSON.stringify({ success: false, errors: [{ code: 10007, message: 'This account does not have a workers.dev subdomain' }] }));
    return send(200, JSON.stringify({ success: true, result: { subdomain: readFileSync(f, 'utf8') } }));
  }
  if ((m = /^\/bot([^/]+)\/sendDocument$/.exec(p))) {
    // Multipart: keep the uploaded file and the chat id, as Telegram would.
    const raw = Buffer.from(body, 'latin1');
    const text = raw.toString('latin1');
    const chat = /name="chat_id"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? '';
    const start = text.indexOf('\r\n\r\n', text.indexOf('name="document"')) + 4;
    const end = text.indexOf('\r\n--', start);
    writeFileSync(join(STATE, 'received-document'), raw.subarray(start, end));
    appendFileSync(join(STATE, 'telegram.jsonl'), JSON.stringify({ method: 'sendDocument', token_ok: m[1] === token(), chat_id: chat, text: '', bytes: end - start }) + '\n');
    return send(200, '{"ok":true}');
  }
  if ((m = /^\/bot([^/]+)\/(getWebhookInfo|deleteWebhook)$/.exec(p))) {
    if (m[1] !== token()) return send(401, '{"ok":false}');
    if (m[2] === 'deleteWebhook') {
      writeFileSync(join(STATE, 'webhook.json'), '{}');
      appendFileSync(join(STATE, 'telegram.jsonl'), JSON.stringify({ method: 'deleteWebhook', token_ok: true, chat_id: '', text: '' }) + '\n');
      return send(200, '{"ok":true,"result":true}');
    }
    const w = webhook();
    return send(200, JSON.stringify({ ok: true, result: { url: w.url ?? '', has_custom_certificate: false, pending_update_count: 0, ...(w.url ? { max_connections: 40, ip_address: '203.0.113.7', allowed_updates: w.allowed_updates ?? ['message'] } : {}) } }));
  }
  if ((m = /^\/bot([^/]+)\/(sendMessage|setWebhook)$/.exec(p))) {
    const form = new URLSearchParams(body);
    let fields = Object.fromEntries(form);
    if ((req.headers['content-type'] ?? '').includes('json')) fields = JSON.parse(body);
    const entry = { method: m[2], token_ok: m[1] === token(), chat_id: String(fields.chat_id ?? ''), text: fields.text ?? '', url: fields.url ?? '', has_secret_token: Boolean(fields.secret_token) };
    // $STATE/fail-setWebhook makes setWebhook fail (Telegram down for that call), for the retry test.
    if (m[2] === 'setWebhook' && existsSync(join(STATE, 'fail-setWebhook'))) {
      appendFileSync(join(STATE, 'telegram.jsonl'), JSON.stringify({ ...entry, failed: true }) + '\n');
      return send(502, '{"ok":false}');
    }
    appendFileSync(join(STATE, 'telegram.jsonl'), JSON.stringify(entry) + '\n');
    if (m[2] === 'setWebhook' && entry.token_ok) writeFileSync(join(STATE, 'webhook.json'), JSON.stringify({ url: entry.url, allowed_updates: JSON.parse(fields.allowed_updates ?? '["message"]') }));
    return send(entry.token_ok ? 200 : 401, JSON.stringify({ ok: entry.token_ok }));
  }
  if (GIT_ROOT && p.includes('.git/')) {
    const file = normalize(join(GIT_ROOT, p));
    if (!file.startsWith(GIT_ROOT) || !existsSync(file) || !statSync(file).isFile()) return send(404, 'Not Found', 'text/plain');
    return send(200, readFileSync(file), 'application/octet-stream');
  }
  send(404, 'Not Found', 'text/plain');
}).listen(Number(process.env.PORT ?? 8787), '0.0.0.0');
