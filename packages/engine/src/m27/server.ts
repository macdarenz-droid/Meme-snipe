// Loopback-only text `/metrics` endpoint (B-M27-01 logic 3; ARCH 13.1: optional local scraping, no third-party
// monitoring). The listener binds a loopback address only; any other host, including the tailnet address or a
// wildcard, is refused before a socket is opened, so the endpoint is unreachable from the tailnet (acceptance).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export interface MetricsServer { readonly host: string; readonly port: number; close(): Promise<void> }

/** Starts the endpoint; `render` produces the exposition text. Rejects with `E_NOT_LOOPBACK` for any other host. */
export async function startMetricsServer(opts: { host: string; port: number; render: () => string }): Promise<MetricsServer> {
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(opts.host)) {
    throw Object.assign(new Error(`metrics endpoint must bind ${LOOPBACK_HOSTS.join(' or ')}`), { code: 'E_NOT_LOOPBACK' });
  }
  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(opts.render());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: opts.host, port: opts.port, exclusive: true }, () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    host: address.address,
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
