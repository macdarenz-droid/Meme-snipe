import { strict as assert } from 'node:assert';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { describe, it } from 'vitest';
import { startMetricsServer } from '../../src/m27/server.ts';

function get(host: string, port: number, path: string, method = 'GET'): Promise<{ status: number; body: string; type: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode as number, body, type: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.on('connect', () => { socket.destroy(); resolve('connected'); });
    socket.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
  });
}

describe('/metrics on loopback only (B-M27-01 logic 3)', () => {
  it('serves the exposition text on 127.0.0.1 and nothing else', async () => {
    const server = await startMetricsServer({ host: '127.0.0.1', port: 0, render: () => 'rss_bytes 1\n' });
    try {
      assert.equal(server.host, '127.0.0.1');
      assert.deepEqual(await get('127.0.0.1', server.port, '/metrics'), { status: 200, body: 'rss_bytes 1\n', type: 'text/plain; version=0.0.4; charset=utf-8' });
      assert.equal((await get('127.0.0.1', server.port, '/other')).status, 404);
      assert.equal((await get('127.0.0.1', server.port, '/metrics', 'POST')).status, 405);
    } finally {
      await server.close();
    }
  });

  it('acceptance: is unreachable from any non-loopback address of this host (the tailnet address included)', async () => {
    const server = await startMetricsServer({ host: '127.0.0.1', port: 0, render: () => '' });
    try {
      const external = Object.values(networkInterfaces()).flat().filter((a) => a !== undefined && !a.internal).map((a) => (a as { address: string }).address);
      for (const address of external) assert.notEqual(await tryConnect(address, server.port), 'connected', address);
    } finally {
      await server.close();
    }
  });

  it('refuses to bind a wildcard, a tailnet or any other non-loopback address', async () => {
    for (const host of ['0.0.0.0', '::', '100.64.0.1', '192.168.1.10', 'localhost', '']) {
      await assert.rejects(startMetricsServer({ host, port: 0, render: () => '' }), { code: 'E_NOT_LOOPBACK' });
    }
  });

  it('fails to start when the port is taken', async () => {
    const first = await startMetricsServer({ host: '127.0.0.1', port: 0, render: () => '' });
    try {
      await assert.rejects(startMetricsServer({ host: '127.0.0.1', port: first.port, render: () => '' }), { code: 'EADDRINUSE' });
    } finally {
      await first.close();
    }
  });
});
