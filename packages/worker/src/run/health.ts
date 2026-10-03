// The loopback health endpoint and the feed-drop drill (docs/ARCHITECTURE.md §12.4). No inbound port opens: the
// address is loopback only (config refuses anything else). The drill needs the per-boot token from `drill.token`.
import { createServer, type Server } from 'node:http';
import type { Health } from '../../../runner/src/contract.ts';
import { jsonText } from './json.ts';

export interface HealthDeps {
  readonly health: () => Health;
  /** Null when drills are off (the endpoint answers 404). */
  readonly drill: { readonly token: string; readonly dropFeed: (feed: string, ms: number) => boolean } | null;
}

const MAX_BODY = 4_096;

export const startHealthServer = (host: string, port: number, d: HealthDeps): Promise<Server> => {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(jsonText(d.health()));
      return;
    }
    if (d.drill !== null && req.method === 'POST' && req.url === '/drill/drop-feed') {
      if (req.headers['x-zeroed-drill-token'] !== d.drill.token) {
        res.writeHead(403).end();
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        let parsed: { feed?: unknown; ms?: unknown } = {};
        try {
          parsed = JSON.parse(body || '{}') as typeof parsed;
        } catch {
          res.writeHead(400).end();
          return;
        }
        const { feed, ms } = parsed;
        if (typeof feed !== 'string' || typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0 || !d.drill!.dropFeed(feed, ms)) {
          res.writeHead(400).end();
          return;
        }
        res.writeHead(202).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
};
