// Card Z10, ops e2e only: the fake chain (fake-chain.ts) served over HTTPS in real time, so the recorder runs under its
// real unit in the test server (ops/test/e2e.sh section 10b3) with read providers it can reach. The provider is the
// request's Host (`shyft.fake`, `chainstack.fake`; the test maps both to 127.0.0.1). TEST certificate and key, made by
// the e2e. SYNTHETIC trades over real fixture accounts; nothing is read from any network.
//   node --no-warnings fake-rpc-server.ts PORT CERT KEY   (in a release with its package links, logic.sh release_links)
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { FakeChain, VirtualTime } from './fake-chain.ts';

const [port, cert, key] = [Number(process.argv[2] ?? 443), process.argv[3] as string, process.argv[4] as string];
// The chain's slots follow wall time: a virtual time line moved on every 100 ms of real time.
const time = new VirtualTime(Date.UTC(2026, 9, 6, 17, 30, 0));
const realStart = process.hrtime.bigint();
setInterval(() => {
  const ms = Number((process.hrtime.bigint() - realStart) / 1_000_000n) - time.elapsedMs();
  if (ms > 0) void time.advance(ms);
}, 100);
const chain = new FakeChain(time, { seed: 10 });
chain.migrationsVisible = 3;

createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const label = /^([a-z]+)\.fake(?::\d+)?$/.exec(req.headers.host ?? '')?.[1] ?? 'unknown';
  const parts: Buffer[] = [];
  req.on('data', (c: Buffer) => parts.push(c));
  req.on('end', () => {
    void chain.fetch(`https://${label}.fake/`, { method: 'POST', headers: {}, body: Buffer.concat(parts).toString('utf8'), signal: AbortSignal.timeout(5_000) })
      .then(async (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); })
      .catch(() => { res.writeHead(500); res.end(); });
  });
}).listen(port, '127.0.0.1', () => { process.stdout.write(`fake RPC on 127.0.0.1:${port}\n`); });
