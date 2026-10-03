// Local stand-in for github.com (release downloads, dumb-HTTP git), api.github.com (release metadata) and
// api.telegram.org (sendMessage, setWebhook), for ops/test/e2e.sh. State lives in files under STATE so the
// gh and wrangler stubs can share it. Never logs a request URL (a bot token would be in it): the token is
// only compared with the token Telegram knows and the result recorded as true or false.
//   STATE=dir GIT_ROOT=dir PORT=8787 node fake-services.mjs
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';

const STATE = process.env.STATE;
const GIT_ROOT = process.env.GIT_ROOT;
// The bot token Telegram knows: $STATE/telegram-token (the test rotates it), read on every request.
const token = () => readFileSync(join(STATE, 'telegram-token'), 'utf8');
const rel = (tag) => join(STATE, 'releases', tag);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  let body = '';
  for await (const c of req) body += c;
  const send = (code, data, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(data);
  };

  let m;
  if ((m = /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/secrets\.age$/.exec(p))) {
    const dir = rel(m[1]);
    if (!existsSync(join(dir, 'secrets.age'))) return send(404, 'Not Found', 'text/plain');
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    meta.download_count += 1;
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    return send(200, readFileSync(join(dir, 'secrets.age')), 'application/octet-stream');
  }
  if ((m = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/([^/]+)$/.exec(p))) {
    const dir = rel(m[1]);
    if (!existsSync(join(dir, 'meta.json'))) return send(404, '{"message":"Not Found"}');
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    return send(200, JSON.stringify({ tag_name: m[1], author: { login: meta.author }, assets: [{ name: 'secrets.age', download_count: meta.download_count }] }));
  }
  if ((m = /^\/bot([^/]+)\/(sendMessage|setWebhook)$/.exec(p))) {
    const form = new URLSearchParams(body);
    let fields = Object.fromEntries(form);
    if ((req.headers['content-type'] ?? '').includes('json')) fields = JSON.parse(body);
    const entry = { method: m[2], token_ok: m[1] === token(), chat_id: String(fields.chat_id ?? ''), text: fields.text ?? '', url: fields.url ?? '', has_secret_token: Boolean(fields.secret_token) };
    appendFileSync(join(STATE, 'telegram.jsonl'), JSON.stringify(entry) + '\n');
    return send(entry.token_ok ? 200 : 401, JSON.stringify({ ok: entry.token_ok }));
  }
  if (GIT_ROOT && p.includes('.git/')) {
    const file = normalize(join(GIT_ROOT, p));
    if (!file.startsWith(GIT_ROOT) || !existsSync(file) || !statSync(file).isFile()) return send(404, 'Not Found', 'text/plain');
    return send(200, readFileSync(file), 'application/octet-stream');
  }
  send(404, 'Not Found', 'text/plain');
}).listen(Number(process.env.PORT ?? 8787), '0.0.0.0');
