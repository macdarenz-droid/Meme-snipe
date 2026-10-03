// Stand-in for the signer until SIGN-1 lands. Holds no key. Listens only on a Unix socket in its runtime
// directory (the unit has no network at all) and answers every request with "not ready".
import { chmodSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const path = join(process.env.RUNTIME_DIRECTORY ?? '/run/zeroed-signer', 'signer.sock');
rmSync(path, { force: true });
const server = createServer((sock) => {
  sock.setTimeout(5000, () => sock.destroy());
  sock.on('error', () => {});
  sock.once('data', () => sock.end(JSON.stringify({ status: 'not-ready', reason: 'no key until SIGN-1' }) + '\n'));
});
server.listen(path, () => {
  chmodSync(path, 0o660);
  console.log('Stub signer listening on its Unix socket (no key, not ready).');
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
